package com.dpb.map.v2;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DpbPrint")
public class DpbPrintPlugin extends Plugin {

    // نحتفظ بالـWebView المستقل لحد ما الطباعة تخلص عشان الـGC ما يشيلوش
    private WebView printWebView;

    /** مقاسات الورق المدعومة: A0 لـ A5 (الافتراضي A4). */
    private static PrintAttributes.MediaSize mediaFor(String n) {
        if ("A0".equals(n)) return PrintAttributes.MediaSize.ISO_A0;
        if ("A1".equals(n)) return PrintAttributes.MediaSize.ISO_A1;
        if ("A2".equals(n)) return PrintAttributes.MediaSize.ISO_A2;
        if ("A3".equals(n)) return PrintAttributes.MediaSize.ISO_A3;
        if ("A5".equals(n)) return PrintAttributes.MediaSize.ISO_A5;
        return PrintAttributes.MediaSize.ISO_A4;
    }

    /** الصفحة بتسأل بيها: لو الإضافة دي موجودة يبقى A0–A5 مدعومين. */
    @PluginMethod
    public void info(final PluginCall call) {
        com.getcapacitor.JSObject r = new com.getcapacitor.JSObject();
        r.put("sizes", "A0,A1,A2,A3,A4,A5");
        call.resolve(r);
    }

    /** الطريقة القديمة: بتطبع صفحة التطبيق نفسها. محتفظ بيها للتوافق. */
    @PluginMethod
    public void print(final PluginCall call) {
        final String name = call.getString("name", "DPB");
        final boolean landscape = Boolean.TRUE.equals(call.getBoolean("landscape", false));
        getActivity().runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    WebView wv = getBridge().getWebView();
                    PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    PrintDocumentAdapter adapter = wv.createPrintDocumentAdapter(name);
                    PrintAttributes.MediaSize size = landscape
                        ? PrintAttributes.MediaSize.ISO_A4.asLandscape()
                        : PrintAttributes.MediaSize.ISO_A4;
                    PrintAttributes attrs = new PrintAttributes.Builder().setMediaSize(size).build();
                    pm.print(name, adapter, attrs);
                    call.resolve();
                } catch (Exception e) {
                    call.reject(String.valueOf(e.getMessage()));
                }
            }
        });
    }

    /**
     * الطريقة الجديدة: بتاخد صفحة HTML كاملة (خلفية بيضاء + منطقة الطباعة بس) وبتطبعها من WebView منفصل،
     * فمفيش اعتماد على شكل التطبيق الحي (ده كان سبب المستطيل الداكن الفاضي).
     */
    @PluginMethod
    public void printHtml(final PluginCall call) {
        final String html = call.getString("html");
        final String name = call.getString("name", "DPB");
        final boolean landscape = Boolean.TRUE.equals(call.getBoolean("landscape", false));
        final String sizeName = call.getString("size", "A4");
        if (html == null || html.length() == 0) {
            call.reject("empty html");
            return;
        }
        getActivity().runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    final WebView wv = new WebView(getActivity());
                    printWebView = wv;
                    wv.getSettings().setJavaScriptEnabled(false);
                    wv.setWebViewClient(new WebViewClient() {
                        private boolean started = false;
                        @Override public void onPageFinished(WebView view, String url) {
                            if (started) return;
                            started = true;
                            try {
                                PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                                PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(name);
                                PrintAttributes.MediaSize base = mediaFor(sizeName);
                                PrintAttributes.MediaSize size = landscape ? base.asLandscape() : base.asPortrait();
                                PrintAttributes attrs = new PrintAttributes.Builder()
                                    .setMediaSize(size)
                                    .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                                    .build();
                                pm.print(name, adapter, attrs);
                                call.resolve();
                            } catch (Exception e) {
                                call.reject(String.valueOf(e.getMessage()));
                            }
                        }
                    });
                    wv.loadDataWithBaseURL("https://localhost/", html, "text/html", "UTF-8", null);
                } catch (Exception e) {
                    call.reject(String.valueOf(e.getMessage()));
                }
            }
        });
    }
}
