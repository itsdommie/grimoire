package io.github.itsdommie.grimoire;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Keeps small secrets (the advisor's Anthropic API key) encrypted with a key that lives in the Android Keystore and never leaves it, so
 * the secret is not readable from the app's files, from a backup, or by another app. The ciphertext sits in a private preferences file.
 *
 * get({ name }) -> { value: string | null }     set({ name, value })     clear({ name })
 */
@CapacitorPlugin(name = "SecretStore")
public class SecretStorePlugin extends Plugin {
    private static final String KEY_ALIAS = "grimoire-secrets";
    private static final String PREFS = "grimoire_secrets";

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("name");
        String value = call.getString("value");
        if (name == null || value == null) {
            call.reject("name and value are required");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(value.getBytes("UTF-8"));
            ByteBuffer packed = ByteBuffer.allocate(1 + iv.length + encrypted.length);
            packed.put((byte) iv.length).put(iv).put(encrypted);
            prefs().edit().putString(name, Base64.encodeToString(packed.array(), Base64.NO_WRAP)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("couldn't store the secret: " + e.getMessage());
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("name");
        JSObject result = new JSObject();
        String stored = name == null ? null : prefs().getString(name, null);
        if (stored == null) {
            result.put("value", JSObject.NULL);
            call.resolve(result);
            return;
        }
        try {
            ByteBuffer packed = ByteBuffer.wrap(Base64.decode(stored, Base64.NO_WRAP));
            byte[] iv = new byte[packed.get()];
            packed.get(iv);
            byte[] encrypted = new byte[packed.remaining()];
            packed.get(encrypted);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            result.put("value", new String(cipher.doFinal(encrypted), "UTF-8"));
        } catch (Exception e) {
            // The keystore key is gone (a restore onto another phone, a reset lock screen): the secret can't be read, so there is none.
            prefs().edit().remove(name).apply();
            result.put("value", JSObject.NULL);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        String name = call.getString("name");
        if (name != null) prefs().edit().remove(name).apply();
        call.resolve();
    }
}
