/**
 * Genera los hashes bcrypt de las credenciales del seed de demostracion.
 *
 * Uso:  npm run hash
 *
 * Los hashes resultantes se pegan en db/03_seed.sql. Se generan aparte y no
 * en tiempo de arranque porque los scripts de db/ son SQL puro: MySQL no sabe
 * calcular bcrypt. El seed es solo para desarrollo; en produccion las
 * credenciales se crean desde la vista 4 (registro de usuarios).
 */
import bcrypt from 'bcryptjs';

// FSD 6.1: bcrypt con costo >= 12.
const COSTO = 12;

const credenciales = [
  { usuario: 'admin@sigr.local',    password: 'Admin123!',  pin: '1111' },
  { usuario: 'cajero@sigr.local',   password: 'Cajero123!', pin: '2222' },
  { usuario: 'cocinero@sigr.local', password: 'Cocina123!', pin: '3333' },
  { usuario: 'mesero@sigr.local',   password: 'Mesero123!', pin: '4444' },
];

for (const c of credenciales) {
  const hashPassword = bcrypt.hashSync(c.password, COSTO);
  const hashPin = bcrypt.hashSync(c.pin, COSTO);
  console.log(`-- ${c.usuario}  password: ${c.password}  pin: ${c.pin}`);
  console.log(`--   password: ${hashPassword}`);
  console.log(`--   pin:      ${hashPin}`);
  console.log('');
}
