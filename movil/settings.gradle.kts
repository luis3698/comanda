/*
 * Raíz del proyecto móvil.
 *
 * ESTA CARPETA ES AUTÓNOMA. `movil/` se puede copiar a otra máquina o sacar
 * del repositorio de SIGR y sigue compilando por su cuenta: tiene su propio
 * wrapper de Gradle, su propia raíz y ninguna referencia hacia afuera. No hay
 * un `includeBuild` al proyecto web ni rutas con `../`; lo único que comparte
 * con el servidor es el contrato HTTP de la API.
 */
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "SIGR Cliente"
include(":app")
