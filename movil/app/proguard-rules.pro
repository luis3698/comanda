# Reglas de ofuscacion para el APK de release.

# Los DTO se serializan por reflexion con Gson: si R8 les cambia el nombre a
# los campos, el JSON del servidor deja de mapearse y todo llega vacio SIN dar
# ningun error. Es un fallo que solo aparece en release y cuesta mucho ver.
-keep class co.sigr.cliente.datos.red.** { *; }

# Retrofit necesita conservar las firmas genericas de las interfaces.
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepattributes RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keep,allowobfuscation interface co.sigr.cliente.datos.red.ApiSigr

# OkHttp referencia clases opcionales que no estan en Android.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
