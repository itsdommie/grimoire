package io.github.itsdommie.grimoire;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins written for this app are registered by hand (before super.onCreate); Capacitor finds the npm ones itself.
        registerPlugin(TextRecognitionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
