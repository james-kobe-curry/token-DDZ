package com.tokenlandlords.game;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.util.Locale;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GameVoicePlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        configureWebView();
        enterImmersiveMode();
        getWindow().getDecorView().postDelayed(this::enterImmersiveMode, 300);
    }

    @Override
    public void onResume() {
        super.onResume();
        enterImmersiveMode();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersiveMode();
    }

    private void enterImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(
            getWindow(), getWindow().getDecorView()
        );
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );
    }

    private void configureWebView() {
        WebView webView = bridge.getWebView();
        if (webView == null) return;

        webView.setBackgroundColor(Color.rgb(7, 27, 22));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true);
        }

        View insetHost = (View) webView.getParent();
        ViewCompat.setOnApplyWindowInsetsListener(insetHost, (view, windowInsets) -> {
            Insets cutout = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout());
            float density = getResources().getDisplayMetrics().density;
            int top = Math.round(cutout.top / density);
            int right = Math.round(cutout.right / density);
            int bottom = Math.round(cutout.bottom / density);
            int left = Math.round(cutout.left / density);
            String script = String.format(
                Locale.US,
                "document.documentElement.style.setProperty('--safe-area-inset-top','%dpx');" +
                    "document.documentElement.style.setProperty('--safe-area-inset-right','%dpx');" +
                    "document.documentElement.style.setProperty('--safe-area-inset-bottom','%dpx');" +
                    "document.documentElement.style.setProperty('--safe-area-inset-left','%dpx');",
                top, right, bottom, left
            );
            Runnable injectInsets = () -> webView.evaluateJavascript(script, null);
            webView.post(injectInsets);
            webView.postDelayed(injectInsets, 450);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(insetHost);
    }
}
