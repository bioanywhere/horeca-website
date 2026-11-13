export const EQUIVALENCIAS = [
  { dice: ['pimpina', 'pimpinas'], catalogo: 'cuñete', nota: 'cuñete (20 L)' },
  { dice: ['vaso de tinto', 'vasos de tinto', 'vaso para tinto', 'vasos para tinto', 'vaso tinto'], catalogo: 'vaso 4 oz papel', nota: 'vaso de cartón de 4 onzas', reemplaza: true },
  { dice: ['vaso para agua', 'vasos para agua', 'vaso de agua', 'vasos de agua'], catalogo: 'vaso 7 oz 6 oz cónico', nota: 'vaso de 7 onzas, de 6 onzas o vaso cónico (ofrece esas presentaciones)', reemplaza: true },
  { dice: ['sorbete', 'sorbetes'], catalogo: 'pitillo' },
  { dice: ['límpido', 'limpido', 'clorox', 'cloro'], catalogo: 'hipoclorito blanqueador', nota: 'hipoclorito / blanqueador' },

  { dice: ['papel higiénico', 'papel higienico'], catalogo: 'ph', nota: 'en el catálogo el papel higiénico se abrevia PH (p. ej. «PH BCO ECO NUBE MAX X12 ROLLOS»)' },
  { dice: ['carpeta az', 'carpetas az', 'archivador az', 'archivadores az'], catalogo: 'legajador az', nota: 'carpeta AZ = legajador AZ' },
  { dice: ['bolsa grande', 'bolsas grandes', 'bolsa de basura grande', 'bolsas de basura grandes', 'bolsas para la basura grandes', 'bolsa para la basura grande'], catalogo: 'jumbo nn 36x44', nota: 'bolsa de basura grande = Jumbo (28.5x36) o NN (36x44), NO la mediana' },
  { dice: ['bolsa pequeña', 'bolsas pequeñas', 'bolsa de basura pequeña', 'bolsas de basura pequeñas', 'bolsas para la basura pequeñas', 'bolsa para la basura pequeña'], catalogo: 'canequera 19x22', nota: 'bolsa de basura pequeña = canequera (19x22)' },
  { dice: ['lavaloza'], catalogo: 'lavaplatos' },
  { dice: ['estropajo', 'sabra', 'sábra'], catalogo: 'esponjilla fibra', nota: 'esponjilla / fibra' },
  { dice: ['quitagrasa', 'quitagrasas'], catalogo: 'desengrasante' },
  { dice: ['caneca', 'canecas'], catalogo: 'papelera' },
  { dice: ['vinipel'], catalogo: 'película film', nota: 'película plástica (film)' },
  { dice: ['poliestireno'], catalogo: 'icopor', nota: 'icopor = poliestireno (vasos, platos, neveras)' },
  { dice: ['churrusco'], catalogo: 'cepillo' },
  { dice: ['mecha', 'mechas'], catalogo: 'trapero', nota: 'mecha = repuesto de trapero; en el catálogo se titula «TRAPERO …» (con «COPA» o «C/ACOP» si es de rosca)' },
  { dice: ['mopa', 'trapeador'], catalogo: 'trapero' },
  { dice: ['cabo'], catalogo: 'mango' },
  { dice: ['ph'], catalogo: 'papel higiénico' },
  { dice: ['mascarilla', 'mascarillas'], catalogo: 'tapabocas' },
  { dice: ['disolvente', 'thinner', 'tiner'], catalogo: 'varsol' },

  { dice: ['rosca', 'con rosca', 'de rosca'], catalogo: 'copa acople', nota: 'trapero/mecha de rosca = «COPA» o «C/ACOP» en el catálogo' },
  { dice: ['vasos cafeteros', 'vaso cafetero', 'vaso para cafe', 'vasos para cafe', 'vaso de cafe', 'vasos de cafe'], catalogo: 'vaso papel 4 oz 7 oz', nota: 'vaso cafetero = vaso de papel de 4 a 7 oz' },
  { dice: ['vaso desechable', 'vasos desechables', 'vaso plastico', 'vasos plasticos'], catalogo: 'vaso conico plastico', nota: 'vaso desechable/plástico para agua = vaso cónico o plástico (una TAPA no es un vaso)' },
  { dice: ['rollos x 250', 'rollo x 250', 'rollos x250', 'rollo x250', 'rollos de 250', 'rollo de 250'], catalogo: 'ph jumbo 250', nota: 'rollos x 250 = papel higiénico jumbo de 250 m' },
  { dice: ['rollo de nn', 'rollo nn', 'rolla de nn', 'rolla nn', 'rollo de bolsas', 'rolla de bolsas'], catalogo: 'rollox50', nota: 'rollo de bolsas NN = presentación ROLLOX50' },
  { dice: ['galon', 'galones'], catalogo: '3785 3800 3850', nota: 'galón = 3.785 a 3.850 ml en los títulos' },
  { dice: ['doble a'], catalogo: 'pila aa' },
  { dice: ['triple a'], catalogo: 'pila aaa' },
  { dice: ['bateria', 'baterias'], catalogo: 'pila', nota: 'baterías = pilas' },
  { dice: ['pala recogedora de basura', 'pala recogedora', 'pala de recoger', 'pala para basura', 'pala de basura', 'pala recogedor'], catalogo: 'recogedor', reemplaza: true },
  { dice: ['exprimidor'], catalogo: 'escurridor' },
  { dice: ['escurridor'], catalogo: 'exprimidor' },
  { dice: ['mezcladores', 'mezclador', 'agitadores', 'agitador', 'removedores', 'removedor'], catalogo: 'palo mezclador', nota: 'mezcladores/agitadores de café = palo mezclador' },
  { dice: ['endulzante', 'endulzantes', 'edulcorante', 'stevia'], catalogo: 'stevia sucraladiet' },
  { dice: ['wypall', 'wyplas', 'wipall', 'wiplas'], catalogo: 'pano ind', nota: 'Wypall = paño industrial (PAÑO IND PRO…)' },
  { dice: ['motoso', 'motosos'], catalogo: 'trapero acople copa', nota: 'motoso = mopa/repuesto de trapero' },
  { dice: ['sachet', 'sachets'], catalogo: 'sobres' },
  { dice: ['lava platos', 'lava loza'], catalogo: 'lavaloza lavaplatos' },
  { dice: ['brillo'], catalogo: 'esponja brillo esponjilla', nota: 'brillo = esponja brillo / esponjilla' },
  { dice: ['palito', 'palitos'], catalogo: 'varitas', nota: 'ambientador de palito = de varitas' },
  { dice: ['jabon lavaplatos', 'jabon de lavaplatos', 'lavaplatos en crema', 'crema lavaplatos'], catalogo: 'crema lavaplatos lavaloza' },
  { dice: ['interdoblada', 'interdobladas', 'interfoliada', 'interfoliadas'], catalogo: 'interf toalla z', nota: 'toalla interdoblada = interfoliada o toalla Z' },
  { dice: ['resma ecologica', 'resmas ecologicas'], catalogo: 'resma earth pact' },
  { dice: ['aceite de cocina', 'aceite de palma', 'aceite vegetal'], catalogo: 'aceite girasol oleoflor vegetal' },
];


export const NORMALIZACIONES = [
  [/\b(\d+)\s*(onzas?|onz|oz)\b/g, 'oz$1'],

  [/\bx\s*(\d+)\b/g, 'x$1'],
];

const quitarTildes = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


const PATRONES = EQUIVALENCIAS.flatMap((e) =>

  [...new Set(e.dice.map(quitarTildes))].map((d) => ({ re: new RegExp(`\\b${escapar(d)}\\b`, 'g'), a: quitarTildes(e.catalogo), reemplaza: Boolean(e.reemplaza) }))
).sort((x, y) => y.re.source.length - x.re.source.length);


export function expandirConsulta(consulta) {
  let c = quitarTildes(consulta);
  for (const p of PATRONES) c = c.replace(p.re, (m) => (p.reemplaza ? p.a : `${m} ${p.a}`));
  for (const [re, a] of NORMALIZACIONES) c = c.replace(re, a);
  return c;
}


export function textoParaPrompt() {
  return EQUIVALENCIAS.map((e) => `${e.dice.slice(0, 2).join('/')} = ${e.nota || e.catalogo}`).join('; ');
}
