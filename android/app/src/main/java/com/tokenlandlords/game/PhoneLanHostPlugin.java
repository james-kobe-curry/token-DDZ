package com.tokenlandlords.game;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.List;

@CapacitorPlugin(name = "PhoneLanHost")
public class PhoneLanHostPlugin extends Plugin implements PhoneLanServer.Listener {
    private PhoneLanServer server;

    @PluginMethod
    public synchronized void start(PluginCall call) {
        int port = call.getInt("port", 4174);
        try {
            if (server == null) server = new PhoneLanServer(getContext(), this);
            int activePort = server.start(port);
            List<String> addresses = server.httpAddresses();
            JSObject result = new JSObject();
            result.put("port", activePort);
            result.put("httpAddresses", new JSArray(addresses));
            result.put("webSocketUrl", "ws://127.0.0.1:" + activePort + "/ws");
            call.resolve(result);
        } catch (Exception error) {
            if (server != null) server.stop();
            server = null;
            call.reject("无法启动手机房主服务：" + safeMessage(error), error);
        }
    }

    @PluginMethod
    public synchronized void stop(PluginCall call) {
        if (server != null) server.stop();
        server = null;
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String clientId = call.getString("clientId", "");
        String message = call.getString("message", "");
        try {
            if (server == null || !server.isRunning()) throw new IOException("手机房主服务未运行");
            server.send(clientId, message);
            call.resolve();
        } catch (Exception error) {
            call.reject(safeMessage(error), error);
        }
    }

    @PluginMethod
    public void closeClient(PluginCall call) {
        String clientId = call.getString("clientId", "");
        if (server != null) server.closeClient(clientId);
        call.resolve();
    }

    @Override
    public void onClientOpen(String clientId) {
        emitClientEvent("clientOpen", clientId, null);
    }

    @Override
    public void onClientMessage(String clientId, String message) {
        emitClientEvent("clientMessage", clientId, message);
    }

    @Override
    public void onClientClose(String clientId) {
        emitClientEvent("clientClose", clientId, null);
    }

    @Override
    public void onServerStopped(String reason) {
        getActivity().runOnUiThread(() -> {
            JSObject payload = new JSObject();
            payload.put("reason", reason);
            notifyListeners("hostStopped", payload);
        });
    }

    private void emitClientEvent(String event, String clientId, String message) {
        getActivity().runOnUiThread(() -> {
            JSObject payload = new JSObject();
            payload.put("clientId", clientId);
            if (message != null) payload.put("message", message);
            notifyListeners(event, payload);
        });
    }

    private static String safeMessage(Throwable error) {
        return error.getMessage() == null ? "未知网络错误" : error.getMessage();
    }

    @Override
    protected synchronized void handleOnDestroy() {
        if (server != null) server.stop();
        server = null;
    }
}
