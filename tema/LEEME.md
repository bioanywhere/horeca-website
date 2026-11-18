# Personalizaciones del tema de Shopify

Estos archivos NO forman parte del código de Node (Vercel/Fly): se editan en el
tema de la tienda (Shopify → Tienda online → Temas → Editar código). Se guardan
aquí como referencia para poder reaplicarlos.

| Archivo | Va en el tema como | Para qué |
|---|---|---|
| `sections/horeca-recompra.liquid` | `sections/horeca-recompra.liquid` | Sección de la página «Repetir mi pedido». Llama a `/apps/asesor/fiscales?recompra=1` y arma el carrito con el último pedido del cliente. |
| `templates/page.recompra.json` | `templates/page.recompra.json` | Plantilla de la página. La página de Shopify usa `template_suffix = recompra` y handle `repetir-pedido`. |
| `assets/component-card-ajustes.css` | Añadir su contenido al final de `assets/component-card.css` | Iguala el tamaño de todas las tarjetas de producto (recuadro cuadrado, imagen contenida). |

La página «Repetir mi pedido» queda enlazada en el menú de cabecera y en el pie.
