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
        super.onCreate(savedInstanceState);

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
}
