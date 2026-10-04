package io.github.itsdommie.grimoire;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens Google's sign-in page in the person's own browser (Google doesn't allow signing in inside an app's own web view). It will open
 * nothing else: the address must be on accounts.google.com over https.
 */
@CapacitorPlugin(name = "ExternalLink")
public class ExternalLinkPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        Uri uri = url == null ? null : Uri.parse(url);
        if (uri == null || !"https".equals(uri.getScheme()) || !"accounts.google.com".equals(uri.getHost())) {
            call.reject("Grimoire only opens Google's sign-in page.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("There is no browser on this phone to sign in with.");
        }
    }
}
