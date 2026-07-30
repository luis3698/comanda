FROM node:22-alpine

WORKDIR /app

# Dependencias primero para aprovechar la cache de capas de Docker.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server/ ./server/
COPY public/ ./public/

# El COPY de arriba corre como root, asi que /app/public queda root:root 755 y
# el proceso (USER node, uid 1000) no puede escribir dentro. Sin esto, subir la
# imagen de un plato falla con EACCES al crear public/uploads: el directorio se
# crea en servicios/imagenes.js, pero el permiso lo decide el sistema de
# archivos. Se crea aqui y se cede al usuario que de verdad va a escribir.
RUN mkdir -p /app/public/uploads && chown -R node:node /app/public/uploads

# Cache de teselas del mapa. Mismo problema y misma solucion que uploads: el
# proceso corre como node y no puede crear un directorio dentro de /app, que es
# de root. Sin esto, servicios/teselas.js falla con EACCES en cada peticion.
#
# No revienta la aplicacion -- el proxy sirve la tesela igualmente y solo
# registra el fallo -- pero la cache queda inutilizada y CADA carga del mapa
# vuelve a descargar de OpenStreetMap, que es justo lo que su politica de uso
# prohibe. Detectado al probar la vista de zonas de entrega.
#
# Va FUERA de public/ a proposito: son archivos que escribe una descarga
# remota, y no deben servirse como estaticos.
RUN mkdir -p /app/.cache/teselas && chown -R node:node /app/.cache

ENV NODE_ENV=production
EXPOSE 3000

# Usuario sin privilegios: el proceso nunca corre como root.
USER node

CMD ["node", "server/index.js"]
