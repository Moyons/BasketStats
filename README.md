# BasketStats

App de estadísticas de baloncesto en directo. Sin backend, sin cuentas: todo se guarda en el propio dispositivo (localStorage) e instala como PWA.

## Uso

Abre `index.html` con cualquier servidor estático, por ejemplo:

```bash
python -m http.server 8080
```

o publícala en GitHub Pages / Netlify (ver más abajo).

## Funciones

- **Partidos en vivo**: registra tiros (libre/2/3, acierto o fallo), rebotes O/D, asistencias, robos, tapones, pérdidas y faltas por jugador. Marcador propio automático, marcador rival manual, deshacer última acción.
- **Plantilla**: alta, edición y dorsales de jugadores.
- **Temporada**: ranking por estadística, tabla completa de promedios/porcentajes, evolución de puntos por partido.
- **Ajustes**: nombre de equipo, exportar/importar copia de seguridad en JSON, borrado de datos.

## Stack

HTML + CSS + JS vanilla. Sin dependencias, sin build. Service worker para uso offline.
