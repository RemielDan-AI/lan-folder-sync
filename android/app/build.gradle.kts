plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.commsync.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.commsync.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// 刻意不引入任何第三方库：只用 Android 框架 + org.json，
// 这样构建时只需要 AGP 和 Kotlin 插件，不依赖 AndroidX 那一堆传递依赖。
dependencies {
    // 差异引擎是纯 Kotlin，可以在 JVM 上直接跑单测
    testImplementation("junit:junit:4.13.2")
}
