const express = require('express');
const { Pool } = require('pg');
const chrono = require('chrono-node');
const { google } = require('googleapis');

// 1.1 Configuración de Google Calendar API
let auth;
try {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
  }
} catch(e) {
  console.error("Error inicializando credenciales de Google:", e);
}
const calendar = google.calendar({ version: 'v3', auth });
const CALENDAR_ID = process.env.CALENDAR_ID || 'primary';

const app = express();
app.use(express.json());

// ==========================================
// 1. Configuración de Base de Datos (PostgreSQL)
// ==========================================
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'bgl_chatbot',
  password: process.env.DB_PASSWORD || 'secret',
  port: process.env.DB_PORT || 5432,
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sesiones (
        telefono VARCHAR(20) PRIMARY KEY,
        estado_actual VARCHAR(50),
        contexto JSONB
      );

      CREATE TABLE IF NOT EXISTS usuarios (
        user_id VARCHAR(50) PRIMARY KEY,
        telefono VARCHAR(20),
        nombre VARCHAR(100),
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS citas (
        cita_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(50) REFERENCES usuarios (user_id),
        servicio TEXT NOT NULL,
        fecha_hora_utc TIMESTAMP NOT NULL,
        duracion_min INTEGER NOT NULL,
        estado VARCHAR(20) DEFAULT 'confirmada',
        google_event_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Base de datos inicializada correctamente. Tablas "sesiones", "usuarios" y "citas" listas.');
  } catch (error) {
    console.error('Error inicializando la base de datos:', error);
  }
}
initDB();
// ==========================================
// 2. Sistema de Bloqueo de Concurrencia (Locks en Memoria)
// ==========================================
// Regla: Encolar mensajes para evitar condiciones de carrera por teléfono
const locks = new Map();

async function acquireLock(phone) {
  // Si no existe un lock para este teléfono, lo inicializamos con una Promesa resuelta
  if (!locks.has(phone)) {
    locks.set(phone, Promise.resolve());
  }

  let release;
  const lockPromise = new Promise(resolve => { release = resolve; });

  const currentLock = locks.get(phone);
  // Encadenamos el nuevo lock al anterior
  locks.set(phone, currentLock.then(() => lockPromise));

  // Esperamos a que termine el procesamiento del lock anterior
  await currentLock;

  return () => { release(); }; // Función para liberar el lock
}

// ==========================================
// 5. Regla Global de Fallback Estricto
// ==========================================
function validateInputForState(estado, texto) {
  // TODO: Implementar validación del input basada en el estado.
  // Ej: si está en SELECCIONANDO_SERVICIO, verificar que el texto sea un número válido.
  // Por ahora, retorna true simulando un input válido.
  return true;
}

function getFallbackMessage(estado) {
  // Diccionario con instrucciones claras por estado
  const instrucciones = {
    'INICIO': 'Cualquier mensaje para comenzar',
    'VALIDANDO_NOMBRE': 'Tu nombre completo',
    'TIPIFICANDO_USUARIO': 'Si eres paciente "Nuevo" o "Recurrente"',
    'GENERANDO_ID_UNICO': 'Espera un momento',
    'MOSTRANDO_CATALOGO': 'El número del servicio',
    'SELECCIONANDO_SERVICIO': 'Confirma el servicio',
    'SOLICITANDO_FECHA_HORA': 'La fecha y hora deseada',
    'ANALIZANDO_TIEMPO': 'Espera un momento',
    'RESOLVIENDO_AMBIGUEDAD': 'Aclara la fecha o la hora',
    'VERIFICANDO_DISPONIBILIDAD': 'Espera un momento',
    'OFERTANDO_ALTERNATIVA': '"Sí" o "No" para aceptar la alternativa',
    'CONFIRMANDO_CITA': '"Sí" para confirmar, "No" para cancelar',
    'SINCRONIZANDO_CALENDAR': 'Espera un momento',
    'FINALIZADO': 'Hola para iniciar nuevamente'
  };

  const instruccion = instrucciones[estado] || 'La información solicitada';
  return `Estamos en el paso de [${estado}]. Por favor responde: [${instruccion}]`;
}

// ==========================================
// 6. Funciones de Identidad y Seguridad
// ==========================================
function validar_nombre(texto) {
  if (!texto) return false;
  const nombreLimpio = texto.trim();
  if (nombreLimpio.length < 5 || nombreLimpio.length > 60) return false;

  const blacklist = ["batman", "superman", "test", "anonimo", "anonimous", "usuario", "cliente", "fulano", "mengano", "sutanito"];
  const palabras = nombreLimpio.split(/\s+/);
  if (palabras.length < 2) return false;

  for (const palabra of palabras) {
    if (blacklist.includes(palabra.toLowerCase())) return false;
  }

  const regexPalabra = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\.\-]{2,}$/;
  for (const palabra of palabras) {
    if (!regexPalabra.test(palabra)) return false;
  }

  return true;
}

function generar_id_unico() {
  const timestamp = Date.now();
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rand = '';
  for (let i = 0; i < 4; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
  return `BLG-${timestamp}-${rand}`;
}

// ==========================================
// 10. MANEJO DE ERRORES Y LOGS
// ==========================================
function generarLogEstructurado({ telefono, estado_actual, mensaje_recibido, respuesta_enviada, duracion_ms, error }) {
  const logObj = {
    timestamp: new Date().toISOString(),
    telefono: telefono || 'Desconocido',
    estado_actual: estado_actual || 'INICIO',
    mensaje_recibido: mensaje_recibido || '',
    respuesta_enviada: respuesta_enviada || 'Procesado',
    duracion_ms: duracion_ms || 0,
    error: error ? error.toString() : null
  };
  console.log(JSON.stringify(logObj));
}

// ==========================================
// Endpoint del Webhook Principal
// ==========================================
app.post('/webhook/whatsapp', async (req, res) => {
  const startTime = Date.now();
  let logTelefono = 'Desconocido';
  let logEstadoInicial = 'DESCONOCIDO';
  let logMensaje = '';

  try {
    // 1. Intercepción del Webhook y Extracción de Datos
    // Adaptar según la estructura de la API (Meta Cloud API, Baileys, Twilio, etc.)
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const messageData = changes?.value?.messages?.[0] || req.body;

    // Si no es un mensaje entrante, retornamos 200 OK
    if (!messageData) return res.status(200).send('EVENT_RECEIVED');

    const phone = messageData.from || messageData.sender;
    const text = messageData.text?.body || messageData.text || '';

    if (!phone || !text) return res.status(200).send('NO_DATA');
    
    logTelefono = phone;
    logMensaje = text;

    // 2. Aplicar el Lock para procesar sincrónicamente por número
    const release = await acquireLock(phone);

    try {
      // 3. Consulta y Persistencia de Sesión (PostgreSQL)
      let session;
      const resSession = await pool.query('SELECT * FROM sesiones WHERE telefono = $1', [phone]);

      if (resSession.rows.length === 0) {
        // Crear nueva sesión
        const insertRes = await pool.query(
          `INSERT INTO sesiones (telefono, estado_actual, contexto) 
           VALUES ($1, $2, $3) RETURNING *`,
          [phone, 'INICIO', JSON.stringify({})]
        );
        session = insertRes.rows[0];
      } else {
        session = resSession.rows[0];
      }

      let estadoActual = session.estado_actual;
      logEstadoInicial = estadoActual;
      // Parsear contexto asegurándonos que sea un objeto
      let contexto = typeof session.contexto === 'string' ? JSON.parse(session.contexto) : session.contexto;

      // 5. Verificación de la Regla de Fallback
      if (!validateInputForState(estadoActual, text)) {
        const fallbackMsg = getFallbackMessage(estadoActual);

        // TODO: Integrar API de WhatsApp para enviar el fallbackMsg
        console.log(`[FALLBACK] -> ${phone}: ${fallbackMsg}`);

        // No se cambia el estado, termina la ejecución
        return res.status(200).send('FALLBACK_SENT');
      }

      // 4. Máquina de Estados FSM (Switch/Case)
      let siguienteEstado = estadoActual;

      switch (estadoActual) {
        case 'INICIO':
          // TODO: Lógica de saludo y presentación
          siguienteEstado = 'VALIDANDO_NOMBRE';
          break;

        case 'VALIDANDO_NOMBRE':
          if (!validar_nombre(text)) {
            console.log(`[RESPUESTA] -> ${phone}: El nombre que ingresaste no parece real. Por favor, escribe tu nombre completo (nombre y apellido) tal cual aparece en tu documento de identidad.`);
            siguienteEstado = 'VALIDANDO_NOMBRE';
          } else {
            contexto.nombre = text.trim();
            siguienteEstado = 'TIPIFICANDO_USUARIO';
          }
          break;

        case 'TIPIFICANDO_USUARIO':
          // TODO: Validar si es nuevo o recurrente. Si falla, se queda en el mismo estado.
          siguienteEstado = 'GENERANDO_ID_UNICO';
          break;

        case 'GENERANDO_ID_UNICO':
          const nuevoId = generar_id_unico();
          contexto.id_unico = nuevoId;

          try {
            await pool.query(
              `INSERT INTO usuarios (user_id, telefono, nombre) VALUES ($1, $2, $3)
               ON CONFLICT (user_id) DO NOTHING`,
              [nuevoId, phone, contexto.nombre || '']
            );
            console.log(`[RESPUESTA] -> ${phone}: Tu código personal BLG es: ${nuevoId}. Guárdalo para futuras referencias.`);
          } catch (error) {
            console.error('Error guardando en tabla usuarios:', error);
          }

          siguienteEstado = 'MOSTRANDO_CATALOGO';
          break;

        case 'MOSTRANDO_CATALOGO':
          const payloadCatalogo = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: phone,
            type: "interactive",
            interactive: {
              type: "list",
              header: {
                type: "text",
                text: "Catálogo de Servicios BLG"
              },
              body: {
                text: "Por favor, revisa nuestros planes y selecciona el que mejor se ajuste a tu proyecto:\n\n1. Empresarial / CRM Custom - $3,000+ USD: Solución a nivel corporativo, CRM avanzado, ecosistema de automatización completo, algoritmos específicos, múltiples agentes de IA, servidores dedicados premium, soporte 24/7. Mantenimiento a convenir.\n2. Plan Starter - $350 USD: 1 mes hosting/dominio gratis, landing page alta conversión, captación de leads estándar, automatización inicial, integración básica BD. Mantenimiento $40/mes.\n3. ⭐ Plan Growth - $750 USD (MÁS POPULAR): 3 meses hosting/dominio gratis, todo Starter + dashboard interactivo, calificación multicanal, chatbot con flujos lógicos, sistema de agendamiento automático. Mantenimiento $80/mes.\n4. Plan Pro SaaS - $1,500 USD: 6 meses hosting/dominio gratis, todo Growth + sistema SaaS o app web a medida, backend Python/SQL, automatización onboarding, reportes dinámicos. Mantenimiento $150/mes."
              },
              action: {
                button: "Ver Planes",
                sections: [
                  {
                    title: "Planes Disponibles",
                    rows: [
                      { id: "PLAN_EMPRESARIAL", title: "Empresarial / CRM", description: "$3,000+ USD" },
                      { id: "PLAN_STARTER", title: "Plan Starter", description: "$350 USD" },
                      { id: "PLAN_GROWTH", title: "⭐ Plan Growth", description: "MÁS POPULAR | $750 USD" },
                      { id: "PLAN_PRO", title: "Plan Pro SaaS", description: "$1,500 USD" }
                    ]
                  }
                ]
              }
            }
          };

          console.log(`[RESPUESTA INTERACTIVA] -> ${phone}: Enviando catálogo interactivo...`);
          // console.log(JSON.stringify(payloadCatalogo, null, 2));
          siguienteEstado = 'SELECCIONANDO_SERVICIO';
          break;

        case 'SELECCIONANDO_SERVICIO':
          let idSeleccionado = text.trim();
          if (messageData.interactive) {
            idSeleccionado = messageData.interactive.list_reply?.id || messageData.interactive.button_reply?.id || idSeleccionado;
          }

          const catalogo = {
            'PLAN_STARTER': { nombre: 'Plan Starter', duracion: 30 },
            'PLAN_GROWTH': { nombre: 'Plan Growth', duracion: 45 },
            'PLAN_PRO': { nombre: 'Plan Pro SaaS', duracion: 60 },
            'PLAN_EMPRESARIAL': { nombre: 'Empresarial / CRM Custom', duracion: 90 }
          };

          const aliases = {
            '1': 'PLAN_EMPRESARIAL',
            '2': 'PLAN_STARTER',
            '3': 'PLAN_GROWTH',
            '4': 'PLAN_PRO',
            'empresarial': 'PLAN_EMPRESARIAL',
            'starter': 'PLAN_STARTER',
            'growth': 'PLAN_GROWTH',
            'pro': 'PLAN_PRO',
            'plan starter': 'PLAN_STARTER',
            'plan growth': 'PLAN_GROWTH',
            'plan pro saas': 'PLAN_PRO',
            'empresarial / crm custom': 'PLAN_EMPRESARIAL'
          };

          const keyBuscada = catalogo[idSeleccionado] ? idSeleccionado : aliases[idSeleccionado.toLowerCase()];
          const planSeleccionado = catalogo[keyBuscada];

          if (planSeleccionado) {
            contexto.servicio_elegido = planSeleccionado.nombre;
            contexto.duracion_minutos = planSeleccionado.duracion;

            console.log(`[RESPUESTA] -> ${phone}: Excelente elección. Por favor, indícame la fecha y hora en la que deseas agendar tu consultoría estratégica (ej. 'mañana a las 3pm' o 'el viernes a las 10am').`);
            siguienteEstado = 'SOLICITANDO_FECHA_HORA';
          } else {
            console.log(`[RESPUESTA] -> ${phone}: Por favor, selecciona una opción válida del catálogo enviando el número o utilizando el menú interactivo.`);
            siguienteEstado = 'SELECCIONANDO_SERVICIO';
          }
          break;

        case 'SOLICITANDO_FECHA_HORA':
          // Guardar intención cruda del usuario y ejecutar el análisis inmediatamente
          contexto.intencionTiempo = text;
          siguienteEstado = 'ANALIZANDO_TIEMPO';
        // Fallthrough intencional para no requerir un nuevo mensaje del usuario

        case 'ANALIZANDO_TIEMPO':
          const intencion = contexto.intencionTiempo;

          // Configuración estricta del motor NLP con chrono-node
          const resultados = chrono.es.parse(intencion, new Date(), {
            timezone: 'America/Caracas',
            forwardDate: true
          });

          if (resultados.length === 0) {
            console.log(`[RESPUESTA] -> ${phone}: No entendí la fecha. Escribe algo como 'lunes 20 a las 10 AM'.`);
            siguienteEstado = 'ANALIZANDO_TIEMPO';
            break;
          }

          const parsed = resultados[0];
          const hasTime = parsed.start.isCertain('hour');
          const propuesta = parsed.start.date();

          // Validar fecha en el pasado
          if (propuesta < new Date()) {
            console.log(`[RESPUESTA] -> ${phone}: No se puede agendar en el pasado. Por favor elige una fecha futura.`);
            siguienteEstado = 'ANALIZANDO_TIEMPO';
            break;
          }

          if (hasTime) {
            contexto.fecha_hora_propuesta = propuesta.toISOString();
            siguienteEstado = 'VERIFICANDO_DISPONIBILIDAD';
          } else {
            contexto.fecha_parcial = propuesta.toISOString();
            const diaStr = propuesta.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });

            // Determinar parte del día basándonos en el input
            let momentoDia = 'tarde';
            const strLower = intencion.toLowerCase();
            if (strLower.includes('mañana')) momentoDia = 'mañana';
            if (strLower.includes('noche')) momentoDia = 'noche';

            console.log(`[RESPUESTA] -> ${phone}: Perfecto, tengo anotado el día ${diaStr}. Para la ${momentoDia}, tenemos disponibilidad en estos horarios: 2:00 PM, 3:30 PM o 5:00 PM. ¿Cuál te funciona mejor?`);
            siguienteEstado = 'RESOLVIENDO_AMBIGUEDAD';
          }
          break;

        case 'RESOLVIENDO_AMBIGUEDAD':
          const horaRegex = /(\d{1,2})\s*[:.]?\s*(\d{2})?\s*(am|pm|AM|PM)?/i;
          const matchHora = text.match(horaRegex);

          if (!matchHora) {
            console.log(`[RESPUESTA] -> ${phone}: No pude identificar la hora. Por favor, indícame un horario como '3:30 PM'.`);
            siguienteEstado = 'RESOLVIENDO_AMBIGUEDAD';
            break;
          }

          let [, horaStr, minStr, meridiem] = matchHora;
          let hora = parseInt(horaStr, 10);
          let min = parseInt(minStr || '0', 10);

          if (meridiem) {
            meridiem = meridiem.toLowerCase();
            if (meridiem === 'pm' && hora < 12) hora += 12;
            if (meridiem === 'am' && hora === 12) hora = 0;
          } else {
            // Asumir PM para horarios de tarde si no se especificó (p.ej. "a las 3")
            if (hora >= 1 && hora <= 8) hora += 12;
          }

          // Fusionar con fecha parcial guardada
          const fechaBase = new Date(contexto.fecha_parcial);
          fechaBase.setHours(hora, min, 0, 0);

          contexto.fecha_hora_propuesta = fechaBase.toISOString();
          console.log(`[ROUTER] Ambigüedad resuelta y fusionada: ${contexto.fecha_hora_propuesta}`);

          siguienteEstado = 'VERIFICANDO_DISPONIBILIDAD';
          break;

        case 'VERIFICANDO_DISPONIBILIDAD':
          try {
            const timeMin = new Date(contexto.fecha_hora_propuesta);
            const duration = contexto.duracion_minutos || 30;
            const timeMax = new Date(timeMin.getTime() + duration * 60000);

            const freeBusyRes = await calendar.freebusy.query({
              requestBody: {
                timeMin: timeMin.toISOString(),
                timeMax: timeMax.toISOString(),
                items: [{ id: CALENDAR_ID }]
              }
            });

            const busySlots = freeBusyRes.data.calendars[CALENDAR_ID].busy || [];
            
            if (busySlots.length > 0) {
              let slotFound = null;

              const startOfDay = new Date(timeMin); startOfDay.setHours(9, 0, 0, 0);
              const endOfDay = new Date(timeMin); endOfDay.setHours(18, 0, 0, 0);
              
              const dayFreeBusy = await calendar.freebusy.query({
                requestBody: {
                  timeMin: startOfDay.toISOString(),
                  timeMax: endOfDay.toISOString(),
                  items: [{ id: CALENDAR_ID }]
                }
              });
              
              const dayBusy = dayFreeBusy.data.calendars[CALENDAR_ID].busy || [];
              dayBusy.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
              
              let currentTime = new Date(timeMin);
              if (currentTime < startOfDay) currentTime = new Date(startOfDay);

              while (currentTime.getTime() + duration * 60000 <= endOfDay.getTime()) {
                const nextEndTime = new Date(currentTime.getTime() + duration * 60000);
                const hasConflict = dayBusy.some(b => {
                  const bStart = new Date(b.start).getTime();
                  const bEnd = new Date(b.end).getTime();
                  return (currentTime.getTime() < bEnd && nextEndTime.getTime() > bStart);
                });

                if (!hasConflict) {
                  slotFound = currentTime;
                  break;
                }
                currentTime = new Date(currentTime.getTime() + 30 * 60000);
              }

              const options = { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' };
              const strOcupado = timeMin.toLocaleString('es-VE', options);

              if (slotFound) {
                contexto.fecha_hora_alternativa = slotFound.toISOString();
                const strLibre = slotFound.toLocaleString('es-VE', options);
                console.log(`[RESPUESTA] -> ${phone}: Lamentablemente, ${strOcupado} ya está ocupado. ¿Te gustaría ${strLibre} en su lugar?`);
                siguienteEstado = 'OFERTANDO_ALTERNATIVA';
                break;
              } else {
                console.log(`[RESPUESTA] -> ${phone}: Lamentablemente, ${strOcupado} ya está ocupado y no encontré más disponibilidad para hoy. Por favor, indícame otra fecha.`);
                siguienteEstado = 'SOLICITANDO_FECHA_HORA';
                break;
              }
            } else {
              siguienteEstado = 'CONFIRMANDO_CITA';
            }
          } catch (error) {
            console.error("[Google API Error]", error);
            console.log(`[RESPUESTA] -> ${phone}: Hubo un problema verificando disponibilidad. Intenta de nuevo en unos segundos.`);
            siguienteEstado = 'VERIFICANDO_DISPONIBILIDAD';
            break;
          }
          if (siguienteEstado !== 'CONFIRMANDO_CITA') break;
          // Fallthrough a CONFIRMANDO_CITA

        case 'CONFIRMANDO_CITA':
          if (estadoActual === 'VERIFICANDO_DISPONIBILIDAD') {
             // Fallthrough desde la verificación. Mandamos el resumen y frenamos el flujo.
             const tMin = new Date(contexto.fecha_hora_propuesta);
             const strLibre = tMin.toLocaleString('es-VE', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
             console.log(`[RESPUESTA] -> ${phone}: ¡Excelente! Tengo el espacio disponible. Resumen: Plan ${contexto.servicio_elegido} para el ${strLibre}. ¿Confirmas agendar esta cita? (Sí/No)`);
             siguienteEstado = 'CONFIRMANDO_CITA';
             break;
          }

          const confirmLower = text.toLowerCase();
          if (confirmLower.includes('sí') || confirmLower.includes('si') || confirmLower.includes('ok')) {
            siguienteEstado = 'SINCRONIZANDO_CALENDAR';
          } else {
            console.log(`[RESPUESTA] -> ${phone}: Cita cancelada. Escribe hola para empezar de nuevo.`);
            contexto = {};
            siguienteEstado = 'INICIO';
            break;
          }
          if (siguienteEstado !== 'SINCRONIZANDO_CALENDAR') break;
          // Fallthrough a SINCRONIZANDO_CALENDAR

        case 'OFERTANDO_ALTERNATIVA':
          if (estadoActual === 'OFERTANDO_ALTERNATIVA') {
            const ansLower = text.toLowerCase();
            if (ansLower.includes('sí') || ansLower.includes('si') || ansLower.includes('claro') || ansLower.includes('ok')) {
              contexto.fecha_hora_propuesta = contexto.fecha_hora_alternativa;
              siguienteEstado = 'SINCRONIZANDO_CALENDAR';
            } else {
              console.log(`[RESPUESTA] -> ${phone}: Entendido. Por favor, indícame una nueva preferencia de fecha y hora.`);
              siguienteEstado = 'SOLICITANDO_FECHA_HORA';
              break;
            }
          }
          if (siguienteEstado !== 'SINCRONIZANDO_CALENDAR') break;
          // Fallthrough a SINCRONIZANDO_CALENDAR

        case 'SINCRONIZANDO_CALENDAR':
          try {
            const timeMin = new Date(contexto.fecha_hora_propuesta);
            const duration = contexto.duracion_minutos || 30;
            const timeMax = new Date(timeMin.getTime() + duration * 60000);

            const evento = {
              summary: `Cita ${contexto.servicio_elegido} ${contexto.nombre}`,
              description: `Usuario ID: ${contexto.id_unico}. Teléfono: ${phone}. Tipo: Persona.`,
              start: {
                dateTime: timeMin.toISOString(),
                timeZone: 'America/Caracas',
              },
              end: {
                dateTime: timeMax.toISOString(),
                timeZone: 'America/Caracas',
              },
            };

            const insertRes = await calendar.events.insert({
              calendarId: CALENDAR_ID,
              requestBody: evento,
            });

            const google_event_id = insertRes.data.id;

            await pool.query(
              `INSERT INTO citas (user_id, servicio, fecha_hora_utc, duracion_min, google_event_id)
               VALUES ($1, $2, $3, $4, $5)`,
              [contexto.id_unico, contexto.servicio_elegido, timeMin.toISOString(), duration, google_event_id]
            );

            const fechaFormat = timeMin.toLocaleString('es-VE', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
            console.log(`[RESPUESTA] -> ${phone}: Cita agendada exitosamente para ${fechaFormat}. Recibirás un recordatorio.`);
            
            contexto = {};
            siguienteEstado = 'FINALIZADO';
          } catch (error) {
            console.error("[Google Insert Error]", error);
            console.log(`[RESPUESTA] -> ${phone}: Hubo un problema agendando tu cita en el calendario. Intenta de nuevo en unos segundos.`);
            siguienteEstado = 'SINCRONIZANDO_CALENDAR';
          }
          break;

        case 'FINALIZADO':
          // Se mantiene por si entra accidentalmente aquí
          contexto = {};
          siguienteEstado = 'INICIO';
          break;

        default:
          console.error(`Estado no mapeado: ${estadoActual}`);
          siguienteEstado = 'INICIO';
          break;
      }

      // Persistir el cambio de estado y el contexto modificado
      if (siguienteEstado !== estadoActual || JSON.stringify(contexto) !== JSON.stringify(session.contexto)) {
        await pool.query(
          'UPDATE sesiones SET estado_actual = $1, contexto = $2 WHERE telefono = $3',
          [siguienteEstado, JSON.stringify(contexto), phone]
        );
      }

      // TODO: Enviar respuesta correspondiente al usuario usando WhatsApp API
      console.log(`[ROUTER] FSM Transición: ${estadoActual} -> ${siguienteEstado} (Contexto actualizado)`);

      const duracion_ms = Date.now() - startTime;
      generarLogEstructurado({
        telefono: logTelefono,
        estado_actual: logEstadoInicial,
        mensaje_recibido: logMensaje,
        respuesta_enviada: `Transición a ${siguienteEstado}`,
        duracion_ms: duracion_ms,
        error: null
      });

    } finally {
      // SIEMPRE liberar el lock, incluso si hay excepciones
      release();
    }

    res.status(200).send('OK');

  } catch (error) {
    console.error('[ERROR] Procesando Webhook WhatsApp:', error);
    
    const duracion_ms = Date.now() - startTime;
    generarLogEstructurado({
      telefono: logTelefono,
      estado_actual: logEstadoInicial,
      mensaje_recibido: logMensaje,
      respuesta_enviada: 'Error de servidor',
      duracion_ms: duracion_ms,
      error: error.message || String(error)
    });

    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FSM Webhook escuchando en el puerto ${PORT}`);
});
