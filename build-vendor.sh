#!/bin/sh
# شغّله مرة واحدة (أو في GitHub Actions قبل بناء الـ APK) من فولدر المشروع. بيطلع www/vendor/firebase-bundle.js
set -e
npm i --no-save firebase@10.12.2 esbuild
mkdir -p www/vendor
npx esbuild vendor-src/firebase-entry.js --bundle --format=esm --minify --target=es2020 --outfile=www/vendor/firebase-bundle.js
ls -la www/vendor/firebase-bundle.js
