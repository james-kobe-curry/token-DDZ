package com.tokenlandlords.game;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@CapacitorPlugin(name = "GameVoice")
public class GameVoicePlugin extends Plugin implements TextToSpeech.OnInitListener {
    private TextToSpeech textToSpeech;
    private boolean ready = false;
    private boolean initializationFailed = false;
    private final List<SpeechRequest> pending = new ArrayList<>();

    private static class SpeechRequest {
        final String text;
        final float rate;
        final float pitch;
        final float volume;
        final boolean interrupt;

        SpeechRequest(String text, float rate, float pitch, float volume, boolean interrupt) {
            this.text = text;
            this.rate = rate;
            this.pitch = pitch;
            this.volume = volume;
            this.interrupt = interrupt;
        }
    }

    @Override
    public void load() {
        textToSpeech = new TextToSpeech(getContext().getApplicationContext(), this);
    }

    @Override
    public void onInit(int status) {
        if (status != TextToSpeech.SUCCESS || textToSpeech == null) {
            initializationFailed = true;
            pending.clear();
            return;
        }
        int languageStatus = textToSpeech.setLanguage(Locale.SIMPLIFIED_CHINESE);
        if (languageStatus == TextToSpeech.LANG_MISSING_DATA || languageStatus == TextToSpeech.LANG_NOT_SUPPORTED) {
            languageStatus = textToSpeech.setLanguage(Locale.CHINA);
        }
        ready = languageStatus != TextToSpeech.LANG_MISSING_DATA && languageStatus != TextToSpeech.LANG_NOT_SUPPORTED;
        initializationFailed = !ready;
        if (!ready) {
            pending.clear();
            return;
        }
        List<SpeechRequest> queued = new ArrayList<>(pending);
        pending.clear();
        for (SpeechRequest request : queued) speakNow(request);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "").trim();
        if (text.isEmpty()) {
            call.resolve();
            return;
        }
        float rate = clamp(call.getDouble("rate", 0.96).floatValue(), 0.65f, 1.3f);
        float pitch = clamp(call.getDouble("pitch", 1.0).floatValue(), 0.8f, 1.2f);
        float volume = clamp(call.getDouble("volume", 0.9).floatValue(), 0f, 1f);
        boolean interrupt = call.getBoolean("interrupt", true);
        SpeechRequest request = new SpeechRequest(text, rate, pitch, volume, interrupt);
        getActivity().runOnUiThread(() -> {
            if (initializationFailed) {
                call.reject("Chinese text-to-speech is unavailable on this device");
                return;
            }
            if (ready) speakNow(request);
            else pending.add(request);
            JSObject result = new JSObject();
            result.put("queued", true);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            pending.clear();
            if (textToSpeech != null) textToSpeech.stop();
            call.resolve();
        });
    }

    private void speakNow(SpeechRequest request) {
        textToSpeech.setSpeechRate(request.rate);
        textToSpeech.setPitch(request.pitch);
        Bundle parameters = new Bundle();
        parameters.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, request.volume);
        textToSpeech.speak(
            request.text,
            request.interrupt ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD,
            parameters,
            "token-landlords-" + System.nanoTime()
        );
    }

    private static float clamp(float value, float minimum, float maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    @Override
    protected void handleOnDestroy() {
        pending.clear();
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
        }
    }
}
