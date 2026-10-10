package com.dpb.map.v2;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DpbPrint")
public class DpbPrintPlugin extends Plugin {
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
}
