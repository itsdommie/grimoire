package io.github.itsdommie.grimoire;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONException;

/**
 * Reads text from an image with Google's on-device ML Kit (bundled Latin model: offline, free, no Play Services needed).
 * The card scanner sends it camera frames and matches the lines it returns against card names.
 *
 * recognize({ image: <base64 JPEG or PNG, no data: prefix> }) resolves with
 *   { width, height, lines: [{ text, left, top, width, height }] }  (box coordinates in pixels of the image)
 */
@CapacitorPlugin(name = "TextRecognition")
public class TextRecognitionPlugin extends Plugin {
    private TextRecognizer recognizer;

    @Override
    public void load() {
        recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    }

    @Override
    protected void handleOnDestroy() {
        if (recognizer != null) recognizer.close();
    }

    @PluginMethod
    public void recognize(final PluginCall call) {
        String data = call.getString("image");
        if (data == null || data.isEmpty()) {
            call.reject("image is required");
            return;
        }
        final Bitmap bitmap;
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException e) {
            call.reject("image is not valid base64");
            return;
        }
        if (bitmap == null) {
            call.reject("image could not be decoded");
            return;
        }
        recognizer.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener(text -> {
                try {
                    JSArray lines = new JSArray();
                    for (Text.TextBlock block : text.getTextBlocks()) {
                        for (Text.Line line : block.getLines()) {
                            Rect box = line.getBoundingBox();
                            JSObject l = new JSObject();
                            l.put("text", line.getText());
                            l.put("left", box == null ? 0 : box.left);
                            l.put("top", box == null ? 0 : box.top);
                            l.put("width", box == null ? 0 : box.width());
                            l.put("height", box == null ? 0 : box.height());
                            lines.put(l);
                        }
                    }
                    JSObject result = new JSObject();
                    result.put("width", bitmap.getWidth());
                    result.put("height", bitmap.getHeight());
                    result.put("lines", lines);
                    call.resolve(result);
                } catch (Exception e) {
                    call.reject("could not read the result: " + e.getMessage());
                } finally {
                    bitmap.recycle();
                }
            })
            .addOnFailureListener(e -> {
                bitmap.recycle();
                call.reject("text recognition failed: " + e.getMessage());
            });
    }
}
