#!/usr/bin/env node
/**
 * Mensajes con opciones — botones, listas, encuestas.
 *
 *   node scripts/test-interactivos.mjs
 *
 * Se prueba contra PAYLOADS REALES, no contra ejemplos inventados, y ésa es la
 * única razón por la que este archivo vale algo. Los dos que usa salieron de la
 * cuenta de wzap el 2026-08-29:
 *
 *   · una encuesta entrante — el caso que rompía todo, porque llega con
 *     `body: null` y el contenido colgando de `poll.name` + `poll.options[]`
 *   · un mensaje de texto con link preview — el caso normal, que tiene que
 *     seguir comportándose exactamente igual que antes
 *
 * La invariante que defiende: **un entrante nunca se pierde por no tener texto
 * plano.** Si se pierde, la conversación queda esperando, el watchdog la cierra
 * por tiempo y el negocio sale reportado como «no contestó» en el informe de un
 * cliente. Una cifra falsa, que es justo lo que ADR 0025 existe para impedir.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// El módulo es puro, así que se puede cargar transpilándolo a mano: no importa
// nada de servidor y no lee process.env. Si algún día lo hiciera, esto falla y
// eso también es una prueba.
// ═══════════════════════════════════════════════════════════════════════════

const fuente = await readFile(join(raiz, 'lib', 'pruebas', 'interactivos.ts'), 'utf8');

check(
  'interactivos.ts no importa nada de servidor',
  !/from '@\/lib\/(supabase|events|ai)/.test(fuente),
  'tiene que poder correr en el navegador y en un test suelto',
);
check(
  'interactivos.ts no lee process.env',
  !/process\.env/.test(fuente.replace(/\/\*[\s\S]*?\*\//g, '')),
);

// Node 24 ejecuta TypeScript directo borrando los tipos. Se importa el archivo
// REAL y no una copia transpilada a mano: una copia prueba la copia.
const { extraerInteractivo, conOpciones, elegirOpcion } = await import(
  pathToFileURL(join(raiz, 'lib', 'pruebas', 'interactivos.ts')).href
);

// ═══════════════════════════════════════════════════════════════════════════
// 1 · LA ENCUESTA REAL — el payload que rompía el parser
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n\x1b[1mLa encuesta real (body: null)\x1b[0m');

const encuesta = {
  id: '3EB0D86C8827018DC7DF',
  type: 'poll',
  subtype: 'text',
  flow: 'inbound',
  from: '573134437050-1444314524@g.us',
  fromNumber: '+573156215988',
  toNumber: '+573138813868',
  body: null,
  poll: {
    name: 'Puedo participar mañana de *9.30 a 10* de la reunión virtual *Inversión en Panamá*',
    invalidated: false,
    expired: true,
    count: 0,
    participants: 0,
    max: 0,
    options: [
      { id: 0, name: 'Siiii, vamos a Facturar!!!!', count: 0, votes: [] },
      { id: 1, name: 'No', count: 0, votes: [] },
    ],
  },
  reactions: [],
  device: { id: '699c83b2e1661ebe3dbbe960', phone: '+573138813868', alias: 'Engel Chia' },
  meta: { isGroup: true, notifyName: 'Daniel Capasso', source: 'web' },
};

const r1 = extraerInteractivo(encuesta);

check('reconoce la clase `poll`', r1.clase === 'poll', `dio ${r1.clase}`);
check('saca el enunciado de poll.name', (r1.texto ?? '').includes('Inversión en Panamá'));
check('saca las dos opciones', r1.opciones.length === 2, `dio ${r1.opciones.length}`);
check('conserva el texto de la opción', r1.opciones[0]?.texto.startsWith('Siiii'));
check('conserva el id del proveedor', r1.opciones[1]?.id === '1', `dio ${r1.opciones[1]?.id}`);
check(
  'NO toma `votes`, `count` ni `participants` como opciones',
  r1.opciones.every((o) => !/^\d+$/.test(o.texto)),
);

const renderizado = conOpciones(r1.texto, r1.opciones);
check('el render numera desde 1', renderizado.includes('[1] Siiii'));
check('el render incluye el enunciado', renderizado.includes('Puedo participar'));
check(
  'el render NO expone el id del proveedor',
  !renderizado.includes('[0]'),
  'el id no sirve para contestar y en la transcripción es ruido',
);

// ═══════════════════════════════════════════════════════════════════════════
// 2 · EL TEXTO NORMAL — no puede cambiar de comportamiento
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n\x1b[1mEl texto normal con link preview\x1b[0m');

const texto = {
  id: '3FEEFDBFFB529E43C8FC',
  type: 'text',
  subtype: 'url',
  flow: 'inbound',
  fromNumber: '+573103565492',
  toNumber: '+573015330011',
  body: 'Enlace:\nhttps://fb.me/aPBg4VYJL\n\n¡Hola! Podrías darme más información de...',
  linkPreview: {
    description: '🏞️ ¡OPORTUNIDAD ÚNICA EN SAN FERNANDO! 🏞️',
    matchedUrl: 'https://fb.me/aPBg4VYJL',
    title: 'Facebook',
  },
  chat: { name: 'Camilord', contact: { name: 'Camilord', phone: '+573103565492' } },
  meta: { isLinkPreview: true, notifyName: 'Camilord' },
};

const r2 = extraerInteractivo(texto);
check('un texto normal no inventa opciones', r2.opciones.length === 0, `dio ${r2.opciones.length}`);
check(
  'el link preview NO se confunde con un menú',
  r2.clase === null || r2.opciones.length === 0,
  `clase ${r2.clase}`,
);
check(
  'conOpciones() sin opciones devuelve el texto tal cual',
  conOpciones('hola', []) === 'hola',
);

// ═══════════════════════════════════════════════════════════════════════════
// 3 · LISTA Y BOTONES — forma inferida del schema de envío, no verificada
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n\x1b[1mLista y botones\x1b[0m');

const lista = {
  type: 'list',
  body: '¿Qué te interesa?',
  list: {
    title: '¿Qué te interesa?',
    button: 'Ver opciones',
    sections: [
      {
        title: 'Opciones',
        rows: [
          { id: 'compra', title: 'Comprar', description: 'Quiero comprar' },
          { id: 'arriendo', title: 'Arrendar' },
        ],
      },
    ],
  },
};

const r3 = extraerInteractivo(lista);
check('lee las filas de list.sections[].rows', r3.opciones.length === 2, `dio ${r3.opciones.length}`);
check('prefiere `title` sobre `description`', r3.opciones[0]?.texto === 'Comprar');
check('conserva el id de la fila', r3.opciones[0]?.id === 'compra');

const botones = {
  type: 'interactive',
  body: 'Elegí una',
  buttons: [
    { id: '1', text: 'Sí' },
    { id: '2', text: 'No' },
  ],
};

const r4 = extraerInteractivo(botones);
check('lee `buttons` entrantes', r4.opciones.length === 2, `dio ${r4.opciones.length}`);
check('usa el body como enunciado', (r4.texto ?? '').includes('Elegí una'));

// ═══════════════════════════════════════════════════════════════════════════
// 3.5 · LA FORMA CORTA — `botones: "x,y,z"`
// ═══════════════════════════════════════════════════════════════════════════
//
// No es de wzap: es la forma que se usa para simular un entrante con curl, donde
// escribir el JSON anidado de una lista es media pantalla. Lo que hay que
// defender es que el atajo no se coma un mensaje normal.

console.log('\n\x1b[1mLa forma corta (botones separados por comas)\x1b[0m');

const corto = {
  id: 'prueba-manual-1',
  body: 'si se necesita se te trata en el tramiento para el tema, no te preocupes.',
  fromNumber: '573103565492',
  flow: 'inbound',
  botones: 'x,y,z',
  device: '69e62a9b0b653ef3ef32e965',
  chat: { name: 'Prueba' },
};

const r5 = extraerInteractivo(corto);
check('parte "x,y,z" en tres opciones', r5.opciones.length === 3, `dio ${r5.opciones.length}`);
check('el enunciado sale del body, no de la cadena de botones', r5.texto === corto.body);
check(
  'el render no repite la cadena cruda',
  !conOpciones(r5.texto, r5.opciones).includes('x,y,z'),
);

const sinBotones = { ...corto };
delete sinBotones.botones;
const r6 = extraerInteractivo(sinBotones);
check('sin `botones` no se rechaza nada', r6.opciones.length === 0 && r6.clase === null);
check(
  'sin `botones` el texto queda intacto',
  conOpciones(r6.texto ?? sinBotones.body, r6.opciones) === corto.body,
);

const vacio = { ...corto, botones: '' };
check('`botones: ""` no inventa opciones', extraerInteractivo(vacio).opciones.length === 0);

check(
  'una frase con comas en `body` NO se parte en opciones',
  extraerInteractivo({ type: 'text', body: 'Hola, sí, claro, con gusto te ayudo.' }).opciones
    .length === 0,
  'partir por comas solo vale dentro de una clave que ya se sabe que trae opciones',
);

// ═══════════════════════════════════════════════════════════════════════════
// 4 · ELEGIR UNA OPCIÓN — cómo se «aprieta» un botón
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n\x1b[1mElegir una opción\x1b[0m');

const ops = [
  { id: 'a', texto: 'Comprar', origen: 'list' },
  { id: 'b', texto: 'Arrendar', origen: 'list' },
  { id: 'c', texto: 'Hablar con un asesor', origen: 'list' },
];

check('por número: "2" → Arrendar', elegirOpcion('2', ops) === 'Arrendar');
check('por número con corchetes: "[3]"', elegirOpcion('[3]', ops) === 'Hablar con un asesor');
check('por número con palabra: "opción 1"', elegirOpcion('opción 1', ops) === 'Comprar');
check('por texto exacto, sin tildes ni caso', elegirOpcion('ARRENDAR', ops) === 'Arrendar');
check('por contención: "quiero arrendar"', elegirOpcion('quiero arrendar', ops) === 'Arrendar');
check(
  'si no matchea, devuelve lo que el modelo escribió',
  elegirOpcion('¿tienen parqueadero?', ops) === '¿tienen parqueadero?',
  'forzar una opción que nadie eligió es peor que una frase libre',
);
check('sin opciones, devuelve la respuesta tal cual', elegirOpcion('hola', []) === 'hola');
check(
  'un número fuera de rango no elige nada',
  elegirOpcion('9', ops) === '9',
);

// ═══════════════════════════════════════════════════════════════════════════
// 5 · EL PARSER DE WZAP — la invariante que importa
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n\x1b[1mEl parser de wzap\x1b[0m');

const wzap = await readFile(join(raiz, 'lib', 'pruebas', 'wzap.ts'), 'utf8');

check(
  'extraerInteractivo() corre ANTES de exigir texto plano',
  wzap.indexOf('extraerInteractivo(data)') < wzap.indexOf('if (!texto) return null'),
  'al revés, un mensaje de solo opciones se descarta y la conversación se cuelga',
);
check('el Entrante lleva las opciones', wzap.includes('opciones: interactivo.opciones'));
check(
  'enviarPorWzap reintenta sin botones cuando los rechazan',
  wzap.includes('reintento como texto numerado'),
  'un mensaje que no sale por un adorno anula la medición entera',
);
check(
  'el sobre de opciones usa `buttons` y `list`, que son los campos que wzap acepta',
  wzap.includes('buttons:') && wzap.includes('list: {'),
);

console.log();
if (failures > 0) {
  console.log(`\x1b[31m${failures} fallo(s)\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mTodo bien.\x1b[0m');
