# Política de seguridad

## Versiones soportadas

Solo se da soporte y se corrigen vulnerabilidades sobre la rama `main`. No hay
versiones paralelas mantenidas.

## Alcance

SIGR maneja información sensible: datos de clientes, pedidos y reservas,
comprobantes de pago, imágenes subidas por usuarios, y credenciales de acceso
del servidor (base de datos, notificaciones push) a través del `.env`.
Cualquier hallazgo relacionado con:

- inyección SQL o cualquier vulnerabilidad de la lista OWASP Top 10,
- bypass de autenticación o de control de roles en la API o en la app móvil,
- acceso indebido a pedidos, reservas o comprobantes de pago de otros
  usuarios,
- exposición de archivos subidos (`public/uploads/`) o de respaldos de la
  base de datos fuera de lo previsto,
- fuga de variables de entorno o secretos del servidor,

se considera un reporte de seguridad válido.

## Cómo reportar una vulnerabilidad

**No abras un issue público** para vulnerabilidades de seguridad. Escribe
directamente a **luisgerardomancilla3698@gmail.com** con:

- una descripción del problema y su impacto potencial,
- los pasos para reproducirlo (o una prueba de concepto),
- si aplica, si se reprodujo en el servidor, en la app Android, o en ambos.

Se confirmará la recepción en un plazo razonable y, una vez validado el
reporte, se trabajará en una corrección antes de hacer cualquier divulgación
pública.
