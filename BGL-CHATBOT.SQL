-- Habilitar extensión para gen_random_uuid() en versiones anteriores a PostgreSQL 13
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Tabla usuarios
CREATE TABLE usuarios (
    user_id VARCHAR(50) PRIMARY KEY,
    nombre TEXT NOT NULL,
    tipo_usuario VARCHAR(20) CHECK (tipo_usuario IN ('Persona', 'Empresa')),
    telefono VARCHAR(20) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Índice obligatorio para la tabla usuarios
CREATE INDEX idx_usuarios_telefono ON usuarios(telefono);

-- 2. Tabla citas
CREATE TABLE citas (
    cita_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(50) REFERENCES usuarios(user_id),
    servicio TEXT NOT NULL,
    fecha_hora_utc TIMESTAMP NOT NULL,
    duracion_min INTEGER NOT NULL,
    estado VARCHAR(20) DEFAULT 'confirmada',
    google_event_id TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Índice obligatorio para la tabla citas
CREATE INDEX idx_citas_fecha_hora_utc ON citas(fecha_hora_utc);

-- 3. Tabla sesiones
CREATE TABLE sesiones (
    session_id TEXT PRIMARY KEY,
    user_id VARCHAR(50) REFERENCES usuarios(user_id),
    estado_actual VARCHAR(50) NOT NULL,
    contexto JSONB,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Índice obligatorio para la tabla sesiones
CREATE INDEX idx_sesiones_updated_at ON sesiones(updated_at);
