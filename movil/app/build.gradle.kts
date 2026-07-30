import java.io.File

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

/*
 * El plugin de Google Services SOLO se aplica si existe google-services.json.
 *
 * Sin esta condición, el proyecto no compila para quien todavía no ha creado
 * su proyecto de Firebase: el plugin falla con "File google-services.json is
 * missing" y bloquea el build entero. Y eso sería absurdo, porque las
 * notificaciones push son un extra: la aplicación funciona sin ellas — los
 * avisos quedan en la bandeja del servidor y el cliente los ve al abrirla.
 *
 * Con esta comprobación, el APK sale igual; simplemente no registra el token.
 */
val hayFirebase = File(projectDir, "google-services.json").exists()
if (hayFirebase) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "co.sigr.cliente"
    compileSdk = 36

    defaultConfig {
        applicationId = "co.sigr.cliente"
        minSdk = 26            // Android 8.0: cubre prácticamente todo el parque actual
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        // La app envía esto en cada petición; el servidor lo compara con el
        // parámetro app.movil.version_minima y puede exigir actualizar.
        buildConfigField("int", "VERSION_APP", "1")

        // ¿Se compiló con Firebase? La app lo consulta para no intentar
        // registrar un token que no existe.
        buildConfigField("boolean", "TIENE_FIREBASE", hayFirebase.toString())
    }

    buildTypes {
        debug {
            // La URL sale de gradle.properties: cambiarla no toca ni una
            // línea de Kotlin.
            buildConfigField(
                "String",
                "API_BASE_URL",
                "\"${project.findProperty("API_BASE_URL_DEBUG") ?: "http://10.0.2.2:3000/"}\""
            )
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField(
                "String",
                "API_BASE_URL",
                "\"${project.findProperty("API_BASE_URL_RELEASE") ?: "https://cambieme.ejemplo.com/"}\""
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    debugImplementation(libs.androidx.ui.tooling)

    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)

    implementation(libs.retrofit)
    implementation(libs.retrofit.gson)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)

    implementation(libs.coil.compose)
    implementation(libs.osmdroid.android)

    // Firebase va SIEMPRE, aunque no haya google-services.json.
    //
    // La dependencia tiene que estar para que `ServicioMensajeria` compile:
    // hereda de FirebaseMessagingService, y sin la biblioteca esa clase no
    // existe. Lo que se aplica de forma condicional es el PLUGIN
    // google-services, que es quien lee el JSON y genera la configuración.
    //
    // Sin plugin, Firebase no se autoinicializa: deja un aviso en el log
    // ("Default FirebaseApp failed to initialize") y nunca invoca al servicio.
    // La aplicación funciona igual y los avisos siguen llegando a la bandeja.
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    // Firebase arrastra `androidx.fragment:1.1.0` a través de
    // play-services-basement. Esta app no usa fragmentos —es Compose entera—,
    // pero el lint de release aborta la compilación igualmente:
    // `registerForActivityResult` exige fragment 1.3.0+ porque las versiones
    // anteriores no llamaban a super.onRequestPermissionsResult().
    //
    // Se sube con una RESTRICCIÓN, no con una dependencia: así no se añade nada
    // al APK si nadie lo pide, y si alguien lo pide, se le da una versión sana.
    constraints {
        implementation(libs.androidx.fragment) {
            because("play-services trae la 1.1.0 y lintVitalRelease exige 1.3.0+")
        }
    }

    testImplementation(libs.junit)
}
