package com.dpb.map.v2;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.util.List;

/** Lets the user pick a backup folder once (Android file picker) and then overwrites files in it. */
@CapacitorPlugin(name = "DpbFolder")
public class DpbFolderPlugin extends Plugin {
    private static final String PREFS = "dpb_folder";
    private static final String KEY = "tree";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, 0);
    }

    @PluginMethod
    public void choose(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, i, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject o = new JSObject();
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            o.put("name", "");
            call.resolve(o);
            return;
        }
        Uri uri = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception e) {
            // permission may already be persisted; writing is checked later
        }
        prefs().edit().putString(KEY, uri.toString()).apply();
        String seg = uri.getLastPathSegment();
        o.put("name", seg == null ? "folder" : Uri.decode(seg));
        call.resolve(o);
    }

    @PluginMethod
    public void has(PluginCall call) {
        JSObject o = new JSObject();
        boolean ok = false;
        String s = prefs().getString(KEY, null);
        if (s != null) {
            Uri u = Uri.parse(s);
            List<UriPermission> perms = getContext().getContentResolver().getPersistedUriPermissions();
            for (UriPermission p : perms) {
                if (p.getUri().equals(u) && p.isWritePermission()) ok = true;
            }
        }
        o.put("has", ok);
        call.resolve(o);
    }

    @PluginMethod
    public void write(PluginCall call) {
        JSObject o = new JSObject();
        String name = call.getString("name");
        String text = call.getString("text");
        String s = prefs().getString(KEY, null);
        if (name == null || text == null || s == null) {
            o.put("ok", false);
            call.resolve(o);
            return;
        }
        try {
            ContentResolver cr = getContext().getContentResolver();
            Uri tree = Uri.parse(s);
            String docId = DocumentsContract.getTreeDocumentId(tree);
            Uri dir = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
            Uri target = findChild(cr, tree, docId, name);
            if (target == null) {
                target = DocumentsContract.createDocument(cr, dir, "application/json", name);
            }
            if (target == null) {
                o.put("ok", false);
                call.resolve(o);
                return;
            }
            OutputStream os = cr.openOutputStream(target, "wt");
            if (os == null) {
                o.put("ok", false);
                call.resolve(o);
                return;
            }
            try {
                os.write(text.getBytes("UTF-8"));
                os.flush();
            } finally {
                os.close();
            }
            o.put("ok", true);
            call.resolve(o);
        } catch (Exception e) {
            o.put("ok", false);
            o.put("error", String.valueOf(e.getMessage()));
            call.resolve(o);
        }
    }

    private Uri findChild(ContentResolver cr, Uri tree, String parentDocId, String name) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentDocId);
        Cursor c = null;
        try {
            c = cr.query(children, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
            if (c == null) return null;
            while (c.moveToNext()) {
                if (name.equals(c.getString(1))) {
                    return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0));
                }
            }
        } finally {
            if (c != null) c.close();
        }
        return null;
    }
}
