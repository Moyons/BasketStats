// Extrae de la web de la FBM los partidos y la clasificación de Chavalitros
// y los guarda en calendario.json. Se ejecuta semanalmente desde GitHub Actions.
// Si cambian los filtros (delegación, competición, categoría, fase, grupo)
// se ajustan en FILTROS.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const URL = "https://www.fbm.es/es/horarios-y-resultados";
const P = "ctl00_ctl00_contenedor_informacion_contenedor_informacion_con_lateral_formulario_";
const EQUIPO = "CHAVALITROS";
const FILTROS = [
  ["DDLDelegacion", "JDM Madrid"],
  ["DDLCompeticiones", "Competiciones JDM"],
  ["DDLCategorias", "Senior Masculino JDM"],
  ["DDLFases", "MORATALAZ"],
  ["DDLGrupos", "DOM MA"],
];

// "04/10/202611:30" -> "2026-10-04T11:30"
function fechaISO(txt) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})\s*(\d{2}):(\d{2})/.exec(txt || "");
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}` : null;
}

async function scrapeGrupo() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: "load", timeout: 90000 });
    for (const [name, texto] of FILTROS) {
      const valor = await page.$$eval(`#${P}${name} option`, (os, t) => {
        const o = os.find(x => x.textContent.trim().toLowerCase().includes(t.toLowerCase()));
        return o ? o.value : null;
      }, texto);
      if (!valor) throw new Error(`Filtro no encontrado: ${texto} (${name})`);
      await Promise.all([
        page.waitForLoadState("load").catch(() => {}),
        page.selectOption(`#${P}${name}`, valor),
      ]);
      await page.waitForTimeout(1500);
    }

    const clasificacion = await page.evaluate(() => {
      const t = [...document.querySelectorAll("table")].find(x => {
        const h = [...x.querySelectorAll("th")].map(h => h.textContent.trim());
        return h.includes("Nombre") && h.includes("Puntos") && h.includes("P.J");
      });
      if (!t) return [];
      const cab = [...t.querySelectorAll("th")].map(h => h.textContent.trim());
      return [...t.querySelectorAll("tbody tr")].map(tr => {
        const c = [...tr.children].map(td => td.textContent.replace(/\s+/g, " ").trim());
        const fila = {};
        cab.forEach((k, i) => { if (k) fila[k] = c[i] ?? ""; });
        return fila;
      }).filter(f => f["Nombre"]);
    });

    const partidos = await page.evaluate(() => {
      const out = [];
      const tablas = [...document.querySelectorAll("table")].filter(t => {
        const h = [...t.querySelectorAll("th")].map(x => x.textContent.trim());
        return h.includes("Local") && h.includes("Visitante") && h.includes("Fecha");
      });
      tablas.forEach((t, ti) => {
        let jornada = "";
        let n = t.previousElementSibling;
        while (n && !jornada) {
          const txt = (n.textContent || "").replace(/\s+/g, " ").trim();
          if (/jornada/i.test(txt) && txt.length < 80) jornada = txt;
          n = n.previousElementSibling;
        }
        if (!jornada) jornada = `Jornada ${ti + 1}`;
        [...t.querySelectorAll("tbody tr")].forEach(tr => {
          const c = [...tr.children].map(td => td.textContent.replace(/\s+/g, " ").trim());
          const local = tr.querySelector('a[id$="HLEquipoLocal"]')?.textContent.trim() || "";
          const visitante = tr.querySelector('a[id$="HLEquipoVisitante"]')?.textContent.trim() || "";
          if (!local && !visitante) return;
          out.push({
            jornada,
            local,
            visitante,
            puntosLocal: tr.querySelector(".puntos_locales")?.textContent.trim() || "",
            puntosVisitante: tr.querySelector(".puntos_visitantes")?.textContent.trim() || "",
            fechaTexto: c[5] || "",
            campo: tr.querySelector('span[id$="LCampoJuego"]')?.textContent.trim() || c[6] || "",
          });
        });
      });
      return out;
    });

    return { partidos, clasificacion };
  } finally {
    await browser.close();
  }
}

(async () => {
  const { partidos: todos, clasificacion } = await scrapeGrupo();
  const equipo = todos.filter(p => p.local.toUpperCase() === EQUIPO || p.visitante.toUpperCase() === EQUIPO);
  if (equipo.length === 0) throw new Error("No se encontró ningún partido de " + EQUIPO + " (¿ha cambiado la web?)");

  const partidos = equipo
    .filter(p => !/DESCANSA/i.test(p.local + p.visitante))
    .map(p => {
      const esLocal = p.local.toUpperCase() === EQUIPO;
      const jugado = p.puntosLocal !== "" && p.puntosVisitante !== "";
      return {
        jornada: p.jornada,
        fecha: fechaISO(p.fechaTexto),
        fechaTexto: p.fechaTexto,
        local: p.local,
        visitante: p.visitante,
        esLocal,
        rival: esLocal ? p.visitante : p.local,
        puntosLocal: jugado ? Number(p.puntosLocal) : null,
        puntosVisitante: jugado ? Number(p.puntosVisitante) : null,
        campo: p.campo,
        jugado,
      };
    })
    .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));

  const salida = {
    actualizado: new Date().toISOString(),
    equipo: EQUIPO,
    fuente: URL,
    clasificacion: clasificacion.map(f => ({
      puesto: Number(f["N°"]) || null,
      nombre: f["Nombre"],
      pj: Number(f["P.J"]) || 0,
      pg: Number(f["P.G"]) || 0,
      pp: Number(f["P.P"]) || 0,
      pf: Number(f["P.F"]) || 0,
      pc: Number(f["P.C"]) || 0,
      puntos: Number(f["Puntos"]) || 0,
    })),
    partidos,
  };
  const destino = path.join(__dirname, "..", "calendario.json");
  fs.writeFileSync(destino, JSON.stringify(salida, null, 2) + "\n");
  console.log(`OK: ${partidos.length} partidos y ${salida.clasificacion.length} equipos en la clasificación guardados en calendario.json`);
})().catch(e => { console.error(e); process.exit(1); });
