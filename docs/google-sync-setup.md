# Setting up Google sync (one-off, for the maintainer)

Brewhall's sync with Google stores one small file in the signed-in person's own **hidden app storage in Google Drive**
(`drive.appdata`). To sign people in, the app needs to be registered with Google once. Nothing here costs anything, and nobody's data
passes through a server of ours (there isn't one).

Google moves things around in the Cloud Console now and then, so the names below may differ a little; the settings are what matter.

## 1. Create the project and turn on Drive

1. Go to <https://console.cloud.google.com/> and create a project called **Brewhall**.
2. **APIs & Services → Library**: search for **Google Drive API** and **Enable** it.

## 2. The consent screen ("Google Auth Platform")

1. **Branding**: app name **Brewhall**, a support email, and (optional) the website <https://itsdommie.github.io/grimoire/>.
   Privacy policy link: <https://itsdommie.github.io/grimoire/#privacy>.
2. **Audience**: choose **External**.
3. **Data Access → Add or remove scopes**: add exactly these three:
   - `openid` and `.../auth/userinfo.email` (to show which account is signed in)
   - `https://www.googleapis.com/auth/drive.appdata` (Brewhall's own hidden storage; no access to the person's other files)
4. Look at how the console classifies each scope. These should all be **non-sensitive**. If `drive.appdata` shows as *sensitive* or
   *restricted*, stop and tell me: it would mean Google has to review the app before strangers can use it.
5. **Audience → Publishing status → Publish app (In production).** This matters: while an external app is left in *Testing*, Google
   expires its sign-ins after **7 days**, so sync would ask everyone to sign in again every week. With only non-sensitive scopes,
   publishing needs no review.

## 3. The desktop client

1. **Clients (Credentials) → Create client → Application type: Desktop app**, name it **Brewhall desktop**.
2. Copy the **Client ID** and **Client secret**. For installed apps Google treats the secret as *not confidential* (it can't be
   kept secret in a program people download), which is why it is fine for it to be inside the app. It is still kept out of the
   repository, and given to the release build as a secret instead.

## 4. Give the release build the client

Add two repository secrets (GitHub → Settings → Secrets and variables → Actions), or from a terminal in this repo:

```
gh secret set GOOGLE_CLIENT_ID
gh secret set GOOGLE_CLIENT_SECRET
```

(`gh` asks for the value; paste it there.) The desktop build workflows read them and build them into the app. Until they are set,
the app says "Google sign-in isn't set up in this build yet" and still offers folder sync.

To try it on your own machine without a release build, start the app with the two values in the environment:

```
GRIMOIRE_GOOGLE_CLIENT_ID=... GRIMOIRE_GOOGLE_CLIENT_SECRET=... npm run desktop
```

## 5. Android (later, once the desktop works)

The Android app needs its own client of type **Android**, with:

- package name `io.github.itsdommie.grimoire`
- the **SHA-1** fingerprint of the release signing key (`keytool -list -v -keystore ~/.grimoire-signing/grimoire-release.p12`, which
  asks for the key password; the SHA-256 recorded in `packages/mobile/signing-sha256.txt` is not what Google asks for here).
  Also add the SHA-1 of the debug key if you want to test debug builds.

Signing in on Android uses the system's own Google account chooser rather than the browser, so it needs a small native part that
can only be tested on a phone or emulator that has Google Play services and a Google account.

## What to check once it is live

- Sign in from the desktop app (footer → **Set up…** → **Sign in with Google**): the browser opens, you agree, the footer says
  *with Google (you@example.com), last synced just now*.
- In Google Drive, **Settings → Manage apps → Brewhall** appears, with a note that it stores hidden app data. That is where the
  person can delete the file or disconnect.
- Leave it a week, then confirm it is still signed in (this is the test that the consent screen really is *In production*).
