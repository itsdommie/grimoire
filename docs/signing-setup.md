# Turning on code signing after SignPath approves the project

1. In SignPath, create the **project** and a **signing policy** (e.g. `release-signing`) and an **artifact configuration** that
   signs `*.exe` inside the uploaded artifact. Set the policy to require approval, with you as approver.
2. Install the **SignPath GitHub App / connector** for the repository and create a CI user token. Add it as the repository secret
   `SIGNPATH_API_TOKEN`; add the organisation, project and policy IDs as repository variables `SIGNPATH_ORGANIZATION_ID`,
   `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`.
3. In `.github/workflows/release.yml`, on the Windows job, replace "Build installers and upload them to the draft release" with:
   build **without publishing** (`npx electron-builder --win --publish never`), upload `release/Grimoire-Setup-*.exe` with
   `actions/upload-artifact`, submit it with `signpath/github-action-submit-signing-request@v1`, wait for completion, download the
   signed file over the original, then run:

   ```
   node scripts/update-latest-yml.mjs release/latest.yml release/Grimoire-Setup-<version>.exe
   ```

   so the update feed's checksum and size match the **signed** installer (signing changes the file, and the auto-updater refuses an
   installer whose checksum doesn't match), and finally upload the signed installer and `latest.yml` to the draft release with
   `gh release upload`.
4. Update `docs/code-signing-policy.md` if the process changed, and remove the "unsigned" notes from the website and README.
5. Optional: also sign `Grimoire.exe` inside the installer (electron-builder's `win.sign` hook calling SignPath) so SmartScreen sees a
   signed application as well as a signed installer.
