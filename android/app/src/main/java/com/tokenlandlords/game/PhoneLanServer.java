package com.tokenlandlords.game;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Base64;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Small foreground-only HTTP/WebSocket server used by an Android phone that
 * hosts a LAN room. Java owns transport and APK asset delivery; the WebView's
 * shared JavaScript rules engine remains the authoritative game state.
 */
final class PhoneLanServer {
    interface Listener {
        void onClientOpen(String clientId);
        void onClientMessage(String clientId, String message);
        void onClientClose(String clientId);
        void onServerStopped(String reason);
    }

    private static final String WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int MAX_HEADER_BYTES = 16 * 1024;
    private static final int MAX_MESSAGE_BYTES = 64 * 1024;
    private final Context context;
    private final Listener listener;
    private final Map<String, WebSocketConnection> clients = new ConcurrentHashMap<>();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private ExecutorService executor;
    private ServerSocket serverSocket;
    private int port;

    PhoneLanServer(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    synchronized int start(int requestedPort) throws IOException {
        if (running.get()) return port;
        if (requestedPort < 1024 || requestedPort > 65535) throw new IOException("端口必须在 1024 到 65535 之间");
        serverSocket = new ServerSocket(requestedPort);
        serverSocket.setReuseAddress(true);
        port = serverSocket.getLocalPort();
        executor = Executors.newCachedThreadPool((task) -> {
            Thread thread = new Thread(task, "token-lan-host");
            thread.setDaemon(true);
            return thread;
        });
        running.set(true);
        executor.execute(this::acceptLoop);
        return port;
    }

    synchronized void stop() {
        if (!running.getAndSet(false)) return;
        closeQuietly(serverSocket);
        for (WebSocketConnection connection : clients.values()) connection.close();
        clients.clear();
        if (executor != null) executor.shutdownNow();
        executor = null;
        serverSocket = null;
    }

    boolean isRunning() {
        return running.get();
    }

    void send(String clientId, String message) throws IOException {
        WebSocketConnection connection = clients.get(clientId);
        if (connection == null) throw new IOException("客户端已经离开房间");
        connection.sendText(message);
    }

    void closeClient(String clientId) {
        WebSocketConnection connection = clients.get(clientId);
        if (connection != null) connection.close();
    }

    List<String> httpAddresses() throws SocketException {
        List<AddressCandidate> candidates = new ArrayList<>();
        Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
        if (interfaces == null) return Collections.emptyList();
        while (interfaces.hasMoreElements()) {
            NetworkInterface network = interfaces.nextElement();
            if (!network.isUp() || network.isLoopback()) continue;
            Enumeration<InetAddress> addresses = network.getInetAddresses();
            while (addresses.hasMoreElements()) {
                InetAddress address = addresses.nextElement();
                if (!(address instanceof Inet4Address) || address.isLoopbackAddress() || !address.isSiteLocalAddress()) continue;
                candidates.add(new AddressCandidate(network.getName(), address.getHostAddress()));
            }
        }
        candidates.sort(Comparator.comparingInt((AddressCandidate candidate) -> interfacePriority(candidate.interfaceName)).thenComparing(candidate -> candidate.address));
        List<String> result = new ArrayList<>();
        for (AddressCandidate candidate : candidates) result.add("http://" + candidate.address + ":" + port);
        return result;
    }

    private static int interfacePriority(String name) {
        String normalized = name == null ? "" : name.toLowerCase(Locale.ROOT);
        if (normalized.startsWith("wlan") || normalized.startsWith("ap")) return 0;
        if (normalized.startsWith("eth")) return 1;
        return 2;
    }

    private void acceptLoop() {
        String stopReason = "";
        try {
            while (running.get()) {
                Socket socket = serverSocket.accept();
                socket.setTcpNoDelay(true);
                socket.setSoTimeout(15000);
                executor.execute(() -> handleSocket(socket));
            }
        } catch (IOException error) {
            if (running.get()) stopReason = error.getMessage() == null ? "房主服务意外停止" : error.getMessage();
        } finally {
            if (!stopReason.isEmpty()) {
                running.set(false);
                listener.onServerStopped(stopReason);
            }
        }
    }

    private void handleSocket(Socket socket) {
        try {
            BufferedInputStream input = new BufferedInputStream(socket.getInputStream());
            BufferedOutputStream output = new BufferedOutputStream(socket.getOutputStream());
            HttpRequest request = readRequest(input);
            if (request == null) return;
            boolean websocket = "websocket".equalsIgnoreCase(request.headers.get("upgrade"));
            if (websocket && "/ws".equals(request.path)) {
                upgradeWebSocket(socket, input, output, request);
            } else {
                serveHttp(output, request);
            }
        } catch (Exception ignored) {
            // A phone may abandon a browser request at any time; the socket is
            // closed below and no shared room state is affected.
        } finally {
            if (!socket.isClosed() && !clients.values().stream().anyMatch((connection) -> connection.socket == socket)) closeQuietly(socket);
        }
    }

    private HttpRequest readRequest(InputStream input) throws IOException {
        ByteArrayOutputStream header = new ByteArrayOutputStream();
        int matched = 0;
        while (header.size() < MAX_HEADER_BYTES) {
            int value = input.read();
            if (value < 0) return null;
            header.write(value);
            if ((matched == 0 || matched == 2) && value == '\r') matched++;
            else if ((matched == 1 || matched == 3) && value == '\n') matched++;
            else matched = value == '\r' ? 1 : 0;
            if (matched == 4) break;
        }
        if (matched != 4) throw new IOException("HTTP 请求头过大");
        String[] lines = header.toString(StandardCharsets.ISO_8859_1.name()).split("\\r\\n");
        if (lines.length == 0) return null;
        String[] firstLine = lines[0].split(" ");
        if (firstLine.length < 2) throw new IOException("HTTP 请求格式错误");
        String rawPath = firstLine[1].split("\\?", 2)[0];
        String path = URLDecoder.decode(rawPath, StandardCharsets.UTF_8.name());
        Map<String, String> headers = new HashMap<>();
        for (int index = 1; index < lines.length; index++) {
            int separator = lines[index].indexOf(':');
            if (separator <= 0) continue;
            headers.put(lines[index].substring(0, separator).trim().toLowerCase(Locale.ROOT), lines[index].substring(separator + 1).trim());
        }
        return new HttpRequest(firstLine[0].toUpperCase(Locale.ROOT), path, headers);
    }

    private void upgradeWebSocket(Socket socket, BufferedInputStream input, BufferedOutputStream output, HttpRequest request) throws IOException, NoSuchAlgorithmException {
        String key = request.headers.get("sec-websocket-key");
        if (key == null || key.isEmpty()) throw new IOException("缺少 WebSocket 密钥");
        byte[] digest = MessageDigest.getInstance("SHA-1").digest((key + WEBSOCKET_GUID).getBytes(StandardCharsets.ISO_8859_1));
        String accept = Base64.encodeToString(digest, Base64.NO_WRAP);
        String response = "HTTP/1.1 101 Switching Protocols\r\n"
            + "Upgrade: websocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        output.write(response.getBytes(StandardCharsets.ISO_8859_1));
        output.flush();
        socket.setSoTimeout(0);
        String clientId = UUID.randomUUID().toString();
        WebSocketConnection connection = new WebSocketConnection(clientId, socket, input, output);
        clients.put(clientId, connection);
        listener.onClientOpen(clientId);
        try {
            connection.readLoop();
        } finally {
            clients.remove(clientId);
            connection.close();
            listener.onClientClose(clientId);
        }
    }

    private void serveHttp(OutputStream output, HttpRequest request) throws IOException {
        if (!("GET".equals(request.method) || "HEAD".equals(request.method))) {
            writeResponse(output, 405, "text/plain; charset=utf-8", "Method Not Allowed".getBytes(StandardCharsets.UTF_8), true);
            return;
        }
        if ("/api/health".equals(request.path)) {
            String body = "{\"ok\":true,\"protocolVersion\":1,\"host\":\"android\"}";
            writeResponse(output, 200, "application/json; charset=utf-8", body.getBytes(StandardCharsets.UTF_8), "HEAD".equals(request.method));
            return;
        }
        String relative = request.path == null ? "" : request.path.replaceFirst("^/+", "");
        if (relative.isEmpty()) relative = "index.html";
        if (relative.contains("..") || relative.contains("\\")) {
            writeResponse(output, 400, "text/plain; charset=utf-8", "Bad Request".getBytes(StandardCharsets.UTF_8), true);
            return;
        }
        byte[] body;
        String servedPath = relative;
        try {
            body = readAsset("public/" + servedPath);
        } catch (IOException missing) {
            servedPath = "index.html";
            body = readAsset("public/index.html");
        }
        writeResponse(output, 200, contentType(servedPath), body, "HEAD".equals(request.method));
    }

    private byte[] readAsset(String path) throws IOException {
        AssetManager assets = context.getAssets();
        try (InputStream input = assets.open(path, AssetManager.ACCESS_STREAMING); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }

    private static void writeResponse(OutputStream output, int status, String contentType, byte[] body, boolean headOnly) throws IOException {
        String label = status == 200 ? "OK" : status == 400 ? "Bad Request" : "Method Not Allowed";
        String header = "HTTP/1.1 " + status + " " + label + "\r\n"
            + "Content-Type: " + contentType + "\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Cache-Control: no-cache\r\n"
            + "X-Content-Type-Options: nosniff\r\n"
            + "Connection: close\r\n\r\n";
        output.write(header.getBytes(StandardCharsets.ISO_8859_1));
        if (!headOnly) output.write(body);
        output.flush();
    }

    private static String contentType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".webp")) return "image/webp";
        return "application/octet-stream";
    }

    private final class WebSocketConnection {
        final String clientId;
        final Socket socket;
        final BufferedInputStream input;
        final BufferedOutputStream output;
        final AtomicBoolean open = new AtomicBoolean(true);

        WebSocketConnection(String clientId, Socket socket, BufferedInputStream input, BufferedOutputStream output) {
            this.clientId = clientId;
            this.socket = socket;
            this.input = input;
            this.output = output;
        }

        void readLoop() throws IOException {
            while (running.get() && open.get()) {
                int first = input.read();
                if (first < 0) break;
                int second = input.read();
                if (second < 0) throw new EOFException();
                boolean finalFrame = (first & 0x80) != 0;
                int opcode = first & 0x0F;
                boolean masked = (second & 0x80) != 0;
                long length = second & 0x7F;
                if (length == 126) length = ((long) readByte(input) << 8) | readByte(input);
                else if (length == 127) {
                    length = 0;
                    for (int index = 0; index < 8; index++) length = (length << 8) | readByte(input);
                }
                if (!masked || length < 0 || length > MAX_MESSAGE_BYTES || !finalFrame) throw new IOException("不支持的 WebSocket 数据帧");
                byte[] mask = readExact(input, 4);
                byte[] payload = readExact(input, (int) length);
                for (int index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
                if (opcode == 0x8) break;
                if (opcode == 0x9) {
                    sendFrame(0xA, payload);
                    continue;
                }
                if (opcode == 0x1) listener.onClientMessage(clientId, new String(payload, StandardCharsets.UTF_8));
            }
        }

        synchronized void sendText(String message) throws IOException {
            if (!open.get()) throw new IOException("WebSocket 已关闭");
            sendFrame(0x1, message.getBytes(StandardCharsets.UTF_8));
        }

        private synchronized void sendFrame(int opcode, byte[] payload) throws IOException {
            if (!open.get()) return;
            output.write(0x80 | opcode);
            if (payload.length <= 125) output.write(payload.length);
            else {
                output.write(126);
                output.write((payload.length >>> 8) & 0xFF);
                output.write(payload.length & 0xFF);
            }
            output.write(payload);
            output.flush();
        }

        void close() {
            if (!open.getAndSet(false)) return;
            closeQuietly(socket);
        }
    }

    private static int readByte(InputStream input) throws IOException {
        int value = input.read();
        if (value < 0) throw new EOFException();
        return value;
    }

    private static byte[] readExact(InputStream input, int length) throws IOException {
        byte[] result = new byte[length];
        int offset = 0;
        while (offset < length) {
            int count = input.read(result, offset, length - offset);
            if (count < 0) throw new EOFException();
            offset += count;
        }
        return result;
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        if (closeable == null) return;
        try { closeable.close(); } catch (IOException ignored) { }
    }

    private static final class HttpRequest {
        final String method;
        final String path;
        final Map<String, String> headers;

        HttpRequest(String method, String path, Map<String, String> headers) {
            this.method = method;
            this.path = path;
            this.headers = headers;
        }
    }

    private static final class AddressCandidate {
        final String interfaceName;
        final String address;

        AddressCandidate(String interfaceName, String address) {
            this.interfaceName = interfaceName;
            this.address = address;
        }
    }
}
