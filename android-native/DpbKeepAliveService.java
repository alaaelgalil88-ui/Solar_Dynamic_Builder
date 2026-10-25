package com.dpb.map.v2;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * v167: keeps the app process alive (foreground service) while the page is still
 * uploading pending edits / the Drive backup, even if the user closes the app screen.
 * The page tells it when to start and when to stop. It never reads or uploads anything itself.
 * Safety: it stops by itself after MAX_MS so it can never stay on forever.
 */
public class DpbKeepAliveService extends Service {
    public static volatile boolean running = false;
    private static final String CHANNEL = "dpb_keepalive";
    private static final int NOTIF_ID = 7731;
    private static final long MAX_MS = 25L * 60L * 1000L;

    private PowerManager.WakeLock wake;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable giveUp = new Runnable() {
        @Override public void run() { stopSelf(); }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent != null ? intent.getStringExtra("text") : null;
        if (text == null || text.length() == 0) text = "جاري رفع البيانات…";
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "DPB رفع البيانات", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
            Notification n = new NotificationCompat.Builder(this, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_sys_upload)
                    .setContentTitle("DPB Map")
                    .setContentText(text)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .build();
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) {
            // could not enter foreground (e.g. started from background): do nothing, the page keeps working as before
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        try {
            if (wake == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dpb:keepalive");
                    wake.setReferenceCounted(false);
                    wake.acquire(MAX_MS);
                }
            }
        } catch (Exception ignored) {}
        handler.removeCallbacks(giveUp);
        handler.postDelayed(giveUp, MAX_MS);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(giveUp);
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignored) {}
        wake = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
