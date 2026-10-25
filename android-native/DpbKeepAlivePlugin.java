package com.dpb.map.v2;

import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** The page calls start() when there is something still to upload and stop() when it is done. */
@CapacitorPlugin(name = "DpbKeepAlive")
public class DpbKeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        JSObject o = new JSObject();
        try {
            Context c = getContext();
            Intent i = new Intent(c, DpbKeepAliveService.class);
            String t = call.getString("text");
            if (t != null) i.putExtra("text", t);
            ContextCompat.startForegroundService(c, i);
            o.put("ok", true);
        } catch (Exception e) {
            o.put("ok", false);
            o.put("error", String.valueOf(e.getMessage()));
        }
        call.resolve(o);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        JSObject o = new JSObject();
        try {
            Context c = getContext();
            c.stopService(new Intent(c, DpbKeepAliveService.class));
            o.put("ok", true);
        } catch (Exception e) {
            o.put("ok", false);
        }
        call.resolve(o);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject o = new JSObject();
        o.put("running", DpbKeepAliveService.running);
        o.put("v", 1);
        call.resolve(o);
    }
}
