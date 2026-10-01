# DPB Map (Capacitor)

1. npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/filesystem @capacitor/share
2. npx cap add android
3. Copy android-native/DpbPrintPlugin.java and android-native/MainActivity.java into
   android/app/src/main/java/com/dpb/map/v2/  (replace MainActivity.java)
4. npx cap sync
5. Open the android folder in Android Studio -> Build APK

appId: com.dpb.map.v2  (must differ from the old app so both can be installed together)
Code.gs lives in Google Apps Script, not in the app.
