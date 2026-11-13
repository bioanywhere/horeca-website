import catalogo from '../datos/catalogo.json' with { type: 'json' };
import { expandirConsulta, NORMALIZACIONES } from './equivalencias.js';

const normalizar = (s) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const VACIAS = new Set([
  'de','del','la','el','los','las','un','una','unos','unas','y','o','para','por','con','sin',
  'que','en','a','al','mi','su','se','lo','es','son','necesito','quiero','pedido','favor',
  'hola','buenos','dias','me','mas','muy','todo','toda','tengo','hacer','armar','crear',
]);

const CONTEXTO = new Set([
  'hotel','hoteles','restaurante','restaurantes','cafeteria','cafeterias','bar','bares',
  'oficina','oficinas','clinica','clinicas','panaderia','panaderias','minimercado','tienda',
  'habitacion','habitaciones','mesa','mesas','comensal','comensales','sede','local','cocina',
  'operacion','negocio','empresa','mes','meses','semana','dia','dias','persona','personas','bano',
  'tamano','tamanos',
]);

const raiz = (t) => {
  if (t.length <= 4) return t;
  if (t.endsWith('ores') || t.endsWith('oras')) return t.slice(0, -4);
  if (t.endsWith('ces')) return t.slice(0, -3) + 'z';
  if (t.endsWith('es') && t.length > 5) return t.slice(0, -2);
  if (t.endsWith('s')) return t.slice(0, -1);
  return t;
};

const SIGLAS = new Set(['nn', 'ph', 'pp', 'ps', 'xl', 'xs', 'dh', 'az', 'aa']);
const trocear = (s) =>
  normalizar(s).split(/[^a-z0-9]+/).filter((t) => (t.length > 2 || SIGLAS.has(t)) && !VACIAS.has(t));

const fichasDeProducto = (s) => trocear(s).filter((t) => !CONTEXTO.has(t)).map(raiz);

const SINONIMOS = {
  'Químicos de Limpieza': ['desengrasante','desinfectante','jabon','detergente','lavaloza','lavaplatos','limpiador','cloro','hipoclorito','ambientador','quimico','blanqueador','sanitizante','alcohol'],
  'Utensilios de Aseo': ['trapero','trapeador','escoba','esponja','estropajo','recogedor','guaype','mopa','balde','fibra','limpion','trapo','aseo'],
  'Papeles Institucionales': ['papel','higienico','toalla','servilleta','rollo','secamanos'],
  'Protección y Primeros Auxilios': ['guante','tapabocas','mascarilla','gorro','cofia','delantal','bota','botiquin','proteccion'],
  'Residuos y Contenedores': ['basura','caneca','contenedor','residuo','papelera','tarro'],
  'Empaques y Bolsas': ['bolsa','empaque','domicilio','film','envase','icopor'],
  'Desechables y Vajilla': ['vaso','copa','plato','cubierto','desechable','pitillo','bandeja','portacomida','cuchara','tenedor'],
  'Menaje y Equipo de Cocina': ['olla','sarten','cuchillo','tabla','recipiente','menaje','utensilio','pinza','colador','vinipel','aluminio','espatula'],
  'Alimentos e Insumos de Cocina': ['salsa','aceite','condimento','especia','insumo','alimento','harina','azucar'],
  'Cuidado Personal y Amenities': ['amenities','shampoo','huesped','dental'],
  'Papelería y Oficina': ['papeleria','boligrafo','cuaderno','factura','carpeta','marcador','resma'],
  'Dispensadores y Equipamiento de Baño': ['dispensador','secador','soporte'],
  'Control de Plagas': ['plaga','insecticida','trampa','raton','cucaracha','veneno'],
};

const familiaPorRaiz = new Map();
for (const [fam, palabras] of Object.entries(SINONIMOS)) {
  for (const p of palabras) {
    const k = raiz(normalizar(p));
    if (!familiaPorRaiz.has(k)) familiaPorRaiz.set(k, new Set());
    familiaPorRaiz.get(k).add(fam);
  }
}

const preparar = (x) => ({
  ...x,

  _t: NORMALIZACIONES.reduce((s, [re, a]) => s.replace(re, a), normalizar(x.t)),
  _tp: normalizar(x.tp),
  _m: normalizar(x.m),
  _f: normalizar(x.f),
});

let preparado = [];
let porId = new Map();
let porHandleMap = new Map();

function reindexar(indice) {
  preparado = indice.map(preparar);
  porId = new Map(indice.map((x) => [String(x.v), x]));

  porHandleMap = new Map();
  for (const x of indice) if (x.h && (!porHandleMap.has(x.h) || (!porHandleMap.get(x.h).d && x.d))) porHandleMap.set(x.h, x);
  return { total: indice.length, disponibles: indice.filter((x) => x.d).length };
}
reindexar(catalogo);

export const FAMILIAS = [...new Set(catalogo.map((x) => x.f).filter(Boolean))].sort();
export const CLIENTES = [...new Set(catalogo.flatMap((x) => x.c || []))].sort();

export function reemplazarIndice(nuevoIndice) {
  if (!Array.isArray(nuevoIndice) || !nuevoIndice.length) {
    return { total: preparado.length, disponibles: preparado.filter((x) => x.d).length, ignorado: true };
  }
  return reindexar(nuevoIndice);
}

let ultimoRefresco = 0;
const FRESCO_MS = Number(process.env.CATALOGO_FRESCO_MS || 6 * 3600 * 1000);

export async function refrescarDesdePersistencia() {
  const { leerIndicePersistido } = await import('./catalogo-bd.js');
  const p = await leerIndicePersistido();
  if (p?.indice?.length) return { ...reemplazarIndice(p.indice), generado: p.generado };
  return null;
}

export async function asegurarCatalogoFresco() {
  if (Date.now() - ultimoRefresco < FRESCO_MS) return;
  ultimoRefresco = Date.now();
  try {
    await refrescarDesdePersistencia();
  } catch {

  }
}

export function familiasDeLaConsulta(consulta) {
  const cuenta = new Map();
  for (const f of fichasDeProducto(consulta)) {
    for (const fam of familiaPorRaiz.get(f) || []) cuenta.set(fam, (cuenta.get(fam) || 0) + 1);
  }
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

export function clienteDeLaConsulta(consulta) {
  const n = normalizar(consulta);

  const ALIAS = {
    'Salud y Cuidado': ['clinica','hospital','consultorio','odontolog','laboratorio','ips','eps'],
    'Domicilios y Comidas Rápidas': ['domicilio','delivery','rapida','comida rapida','food truck'],
    'Restaurantes y Cocinas': ['restaurante','cocina industrial','casino','catering'],
    'Hoteles y Alojamiento': ['hotel','hostal','apartahotel','finca','glamping','motel'],
    'Oficinas e Instituciones': ['oficina','colegio','universidad','institucion','coworking'],
    'Aseo y Mantenimiento': ['aseo','mantenimiento','limpieza industrial','conjunto'],
    'Tiendas y Minimercados': ['tienda','minimercado','supermercado','autoservicio'],
    'Bares y Eventos': ['bar','evento','discoteca','banquete'],
    'Cafeterías y Panaderías': ['cafeteria','panaderia','pasteleria','reposteria'],
  };
  for (const [oficial, alias] of Object.entries(ALIAS)) {
    if (alias.some((a) => n.includes(normalizar(a)))) return oficial;
  }

  return (
    CLIENTES.find((c) =>
      normalizar(c)
        .split(/[^a-z]+/)
        .some((p) => p.length > 4 && n.includes(raiz(p)))
    ) || null
  );
}

export { expandirConsulta };

export function buscarProductos({ consulta = '', familia = null, cliente = null, limite = 12, sinPenalizarAgotados = false } = {}) {

  const fichas = [...new Set(fichasDeProducto(expandirConsulta(consulta)))];

  const famDeducidas = familia ? [familia] : familiasDeLaConsulta(expandirConsulta(consulta));
  const famSet = new Set(famDeducidas.map(normalizar));
  const cliNorm = cliente ? normalizar(cliente) : null;

  const palabra = new Map(fichas.map((f) => [f, new RegExp(`(^|[^a-z0-9])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`)]));
  const casa = (texto, f) => (f.length <= 3 ? palabra.get(f).test(texto) : texto.includes(f));

  const resultados = [];
  for (const x of preparado) {
    if (familia && x._f !== normalizar(familia)) continue;
    if (cliNorm && !(x.c || []).some((c) => normalizar(c) === cliNorm)) continue;

    let punto = 0;
    for (const f of fichas) {
      if (casa(x._t, f)) punto += palabra.get(f).test(x._t) ? 4 : 3;
      else if (casa(x._tp, f)) punto += 2;
      else if (casa(x._m, f)) punto += 2;
    }

    if (famSet.size && famSet.has(x._f)) punto += 6;

    if (punto <= 0) continue;
    if (!x.d && !sinPenalizarAgotados) punto -= 8;
    resultados.push({ ...x, _punto: punto });
  }

  resultados.sort((a, b) => b._punto - a._punto || a.p - b.p);
  return resultados.slice(0, limite).map(({ _t, _tp, _m, _f, _punto, ...r }) => r);
}

export const totalProductos = catalogo.length;

export const porVariante = (v) => porId.get(String(v)) || null;
export const porHandle = (h) => porHandleMap.get(String(h)) || null;
