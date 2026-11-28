# The rules the generated API models and Retrofit need come from :core
# (consumer-rules.pro). App-specific rules go here.

# LiveKit's default audio handler uses Twilio's audioswitch, which the build
# leaves out (JitPack only); the app hands LiveKit its own audio handler, so
# those classes are never loaded.
-dontwarn com.twilio.audioswitch.**
-keep class io.livekit.android.** { *; }
-keep class livekit.org.webrtc.** { *; }
