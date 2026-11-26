# kotlinx.serialization models generated from the OpenAPI files.
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class org.weldsuite.api.**$$serializer { *; }
-keepclassmembers class org.weldsuite.api.** { *** Companion; }
-keepclasseswithmembers class org.weldsuite.api.** { kotlinx.serialization.KSerializer serializer(...); }
# Retrofit interfaces generated from the OpenAPI files.
-keep,allowobfuscation interface org.weldsuite.api.**.apis.*
