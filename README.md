# horeca-asesor

Asesor de compra por lenguaje natural para horecacenter.co.

- **Web** (Vercel): funciones serverless en `api/`.
- **WhatsApp** (Fly): worker en `worker/index.js`.
- Lógica compartida en `lib/`, datos en `datos/`, esquema de base de datos en `bd/`.

## Configuración

Copia `.env.example` y define cada variable en el panel de tu proveedor
(Vercel para la web, Fly para el worker). Nunca subas valores reales al
repositorio.

## Ejecutar

```bash
npm install
npm run bd:aplicar   # aplica el esquema de la base de datos
npm run worker       # arranca el worker de WhatsApp
```

## Despliegue

- **Web**: Vercel (usa `vercel.json`).
- **Worker**: Fly (usa `fly.toml` y `Dockerfile.worker`).
