package com.dpb.map.v2;

import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private long lastGone = 0;
    private int goneCount = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DpbPrintPlugin.class);
        registerPlugin(DpbFolderPlugin.class);
        registerPlugin(DpbKeepAlivePlugin.class);
        super.onCreate(savedInstanceState);

        // قفل ارتداد/تمدد الشاشة (overscroll) على الـWebView كله، فالأجزاء الثابتة فوق وتحت
        // في كل شاشات التطبيق ما تتحركش لما تسحب في آخر القايمة.
        disableOverScroll();

        // لما الأندرويد يقتل صفحة الـWebView عشان الذاكرة، نعمل reload بدل ما التطبيق يقفل.
        // لو حصل أكتر من 3 مرات في دقيقة نسيب السلوك الافتراضي عشان ما ندخلش في لفّة.
        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    long now = System.currentTimeMillis();
                    if (now - lastGone > 60000) goneCount = 0;
                    lastGone = now;
                    goneCount++;
                    if (goneCount > 3) return false;
                    view.post(new Runnable() {
                        @Override
                        public void run() {
                            try { view.reload(); } catch (Exception ignored) {}
                        }
                    });
                    return true;
                }
            });
        }
    }

    private void disableOverScroll() {
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                WebView w = getBridge().getWebView();
                w.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onResume() {
        super.onResume();
        disableOverScroll();
    }

    // v167: while the keep-alive service is running, do not let the WebView freeze its timers/network when the screen is left,
    // so the pending upload can finish. (Not tested on a real phone.)
    private void keepWebViewAlive() {
        try {
            if (DpbKeepAliveService.running && getBridge() != null && getBridge().getWebView() != null) {
                WebView w = getBridge().getWebView();
                w.resumeTimers();
                w.onResume();
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onPause() {
        super.onPause();
        keepWebViewAlive();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepWebViewAlive();
    }
}
