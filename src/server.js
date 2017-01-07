//
//  LuisPa 2017/01/05
//
//  Este program se queda en el background com daemon para 
//  hacer una petición diaria al servidor de Movistar Plus
//  para bajarse el EPG. 
//
'use strict';

// Instalación como desarrollador: 
//
// Clonar desde Github
// npm install o npm install --save request request-promise fs xml2js

// Compilación, instalación del XML y preparado para Tvheadend
//
// $ npm run build && npm run start
// $ scp guia.movistar-xmltv.xml usuario@tu.servidor_tvheadend.com:guia/guia.xml
// $ scp tv.m3u usuario@tu.servidor_tvheadend.com:tv.m3u
// $ ssh tu.servidor_tvheadend.com
// ~tv # cp tv.m3u /etc/tvheadend
// ~tv $ sudo systemctl restart tvheadend
//

// Imports
import Utils from './utils';
import Movistar from './movistar';
import Cadenas from './cadenas';
import fs from 'fs';

// Timers
let timerConversion = undefined;
let timerSessionController = undefined;

// =========================================================
// Constantes
// =========================================================
let progPreferences = {

  // CADENAS:
  // 
  // Variable que apunta al array de cadenas (canales) desde src/cadenas.js
  cadenas: Cadenas,

  // M3U: 
  // 
  // Nombre del fichero de salida donde dejaré la lista de canales IPTV
  ficheroM3U: './tv.m3u',

  // Durante la creación del fichero tv.m3u se pone la URL del canal, pero como 
  // tenemos dos opciones (UDP o TCP) a continuación debes modificar la siguiente
  // variable para adecuarlo a tu caso concreto. 
  // 
  // Este prefijo se pondrá delante del valor de cadenas.movistar_fuente que 
  // encuentras en el fichero src/cadenas.js
  // 
  // Ejemplos con UDP y TCP: 
  // uri_prefix: 'rtp://@'
  // uri_prefix: 'http://x.x.x.x:yyy/udp/'
  uri_prefix: 'http://192.168.100.1:4022/udp/',

  // XMLTV: 
  // Objetivo final: Crear un fichero XMLTV compatible con
  //  "http://xmltv.cvs.sourceforge.net/viewvc/xmltv/xmltv/xmltv.dtd"
  // 

  // Ficheros: En esta versión el proceso crea múltiples ficheros, 
  // - Descargo el EPG que llega en formato XML "propio de Movistar" y lo salvo en "guia.movistar-xml.xml"
  // - Lo convierto a JSON y lo salvo en guia.movistar-xml.json, es una copia del original en XML pero traducida "tal cual" a JSON.
  // - A continuación cambio las "key's" de este fichero a un JSON ya preparado para su traducción sencilla a XMLTV, lo dejo en guia.movistar-xmltv.json
  // - Por último hago el proceso contrario, traduzco de JSON a XMLTV y lo salvo en guia.movistar-xmltv.xml
  //
  // En resumen:   XML(movistar)->JSON(movistar)->JSON(xmltv)->XML(xmltv)
  //
  ficheroXML: './guia.movistar-xml.xml',
  ficheroJSON: './guia.movistar-xml.json',
  ficheroJSONTV: './guia.movistar-xmltv.json',
  ficheroXMLTV: './guia.movistar-xmltv.xml',

  // El programa ejecutará una descarga del EPG nada más arrancar y se quedará 
  // ejecutándose en el background hasta una hora determinada el día siguiente. 
  //
  // La hora se elegirá aleatoriamente entre los dos parámetros siguientes. En
  // el siguiente ejemplo estamos indicando que se elija una hora entre las
  // dos y las siete de la mañana. Si quieres afinar más, puedes poner el mismo 
  // valor a ambas variables, pero te recomiendo dejarlo así. Es una forma 
  // elegante de NO sobrecargar a los servidores de Movistar. 
  horaInicio: 2,
  horaFin: 6,

  // Parámetros para hacer la solicitud a la Web de Movistar: 
  //
  // urlMovistar: URI a donde haremos la petición POST. 
  // dias: número de días de EPG que vamos a solicitar. Nota: he configurado
  //       hardcoded que el máximo aceptado sean 7 (para no cargar a los 
  //       servidores de movistar). 
  urlMovistar: 'http://comunicacion.movistarplus.es/guiaProgramacion/exportar',
  dias: 7,

  // Gestión sobre cuando toca el siguiente ciclo de descarga.
  nextRunDate: 0,
  nextRunMilisegundos: 0,

  // Para mostrar métricas en el log. 
  numChannels: 0,
  numProgrammes: 0,

  // Gestión interna, permite controlar que mientras que haya una conversión 
  // en curso no se saldrá del programa.
  isConversionRunning: false,

  // Modo desarrollador (asume que ya se ha descargado el EPG),
  developerMode: false, // Cambiar a 'false' en producción.

}


// =========================================================
// Mostrar el JSON 'cadenas' de forma elegante
// =========================================================
function comparaCadenasString(a,b) {
  if (a.movistar_numero < b.movistar_numero)
    return -1;
  if (a.movistar_numero > b.movistar_numero)
    return 1;
  return 0;
}
function comparaCadenasInteger(a,b) {
  let aNum=Number(a.movistar_numero);
  let bNum=Number(b.movistar_numero);
  
  if (aNum < bNum)
    return -1;
  if (aNum > bNum)
    return 1;
  return 0;
}

// =========================================================
// Método principal 
// =========================================================

function sessionController() {

  // Paro mi propio timer, lo re-programaré más tarde
  clearInterval(timerSessionController);

  // M3U: 
  // 
  // Genero el fichero .m3u (el encoding por defecto es utf8)
  var wstream = fs.createWriteStream(progPreferences.ficheroM3U);
  wstream.write('#EXTM3U\n');
  progPreferences.cadenas.map(cadena => {
    if ( cadena.tvh_m3u === true ) {
      wstream.write(`#EXTINF:-1 tvh-epg="disable" tvh-chnum="${cadena.movistar_numero}" tvh-tags="tv",${cadena.tvh_nombre}\n`);
      if ( cadena.tvh_fuente !== undefined ) {
        wstream.write(`${cadena.tvh_fuente}\n`);
      } else {
        wstream.write(`${progPreferences.uri_prefix}${cadena.movistar_fuente}\n`);
      }
    }
  });
  wstream.end();


  // XMLTV: 
  // 
  // Calculo cuando tendré que hacer la proxima solicitud
  let ahora = new Date();
  progPreferences.dias = Utils.validaDias(progPreferences.dias);
  progPreferences.diasInicioFin = Utils.fechaInicioFin(progPreferences.dias);
  progPreferences.nextRunDate = Utils.horaAleatoriaTomorrow(progPreferences.horaInicio, progPreferences.horaFin);
  progPreferences.nextRunMilisegundos = progPreferences.nextRunDate - ahora;
  if (progPreferences.nextRunMilisegundos < 0) {
    progPreferences.nextRunMilisegundos += 86400000; // dentro de 24h si algo falla   
  }

  // Inicio el proceso pidiendo el EPG a Movistar
  console.log('--');
  console.log(`Inicio del ciclo de consulta del EPG`);
  console.log('---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ');
  if (progPreferences.developerMode === false) {
    console.log(`1 - Descarga del EPG XML Movistar`);
    console.log(`  => PORT ${progPreferences.urlMovistar}`);
    console.log(`  => EPG ${progPreferences.diasInicioFin.fechaInicio} -> ${progPreferences.diasInicioFin.fechaFin}`);
    Movistar.requestEPG(progPreferences)
      .then((response) => {
        conversionCompletaDeEPGaXMLTV();
      })
      .catch((err) => {
        if (err.error) {
          if (err.error.message) {
            console.log(`1 - Descarga del EPG XML Movistar !! ERROR !!`);
            console.log(`  => Error: ${err.error.message}`);
          }
        }
      });
  } else {
    conversionCompletaDeEPGaXMLTV();
  }
}

// Postprocesa los datos descargados
function conversionCompletaDeEPGaXMLTV() {
  progPreferences.isConversionRunning = true;
  console.log(`1 - Descarga del EPG XML Movistar - OK`);
  // 2 Convertir de formato XML entregado por Movistar a formato JSON intermedio  
  Utils.convierteXMLaJSON(progPreferences.ficheroXML)
    .then((datosJSON) => {
      console.log(`4 - Salva JSON Movistar ${progPreferences.ficheroJSON}`);
      fs.writeFile(progPreferences.ficheroJSON, JSON.stringify(datosJSON, null, 2), function (error) {
        if (error) {
          console.log(`4 - Salva JSON Movistar ${progPreferences.ficheroJSON} !! ERROR !!`);
          progPreferences.isConversionRunning = false;
          reject(error);
        } else {
          console.log(`4 - Salva JSON Movistar ${progPreferences.ficheroJSON} - OK`);

          // Convierto los datos en formato JSON (movistar) a JSON (xmltv)
          console.log(`5 - Convierte JSON(movistar) a JSONTV`);
          let datosJSONTV = Utils.convierteJSONaJSONTV(progPreferences, datosJSON);
          console.log(`5 - Convierte JSON(movistar) a JSONTV - OK`);

          console.log(`6 - Salva JSONTV ${progPreferences.ficheroJSONTV}`);
          fs.writeFile(progPreferences.ficheroJSONTV, JSON.stringify(datosJSONTV, null, 2), function (error) {
            if (error) {
              progPreferences.isConversionRunning = false;
              console.log(`6 - Salva JSONTV ${progPreferences.ficheroJSONTV} !! ERROR !!`);
              reject(error);
            } else {
              console.log(`6 - Salva JSONTV ${progPreferences.ficheroJSONTV} - OK`);

              // Convierto los datos en formato JSONTV a XMLTV
              console.log(`7 - Convierte JSONTV a XMLTV`);
              let datosXMLTV = Utils.convierteJSONTVaXMLTV(datosJSONTV);
              console.log(`7 - Convierte JSONTV a XMLTV - OK`);

              console.log(`8 - Salva XMLTV ${progPreferences.ficheroXMLTV}`);
              fs.writeFile(progPreferences.ficheroXMLTV, datosXMLTV, function (error) {
                if (error) {
                  progPreferences.isConversionRunning = false;
                  console.log(`8 - Salva XMLTV ${progPreferences.ficheroXMLTV} !! ERROR !!`);
                  reject(error);
                }
                console.log(`8 - Salva XMLTV ${progPreferences.ficheroXMLTV} - OK`);
                console.log('');
                console.log(`Hecho!! - ${progPreferences.numChannels} canales y ${progPreferences.numProgrammes} pases`);
                progPreferences.isConversionRunning = false;
              });
            }
          });
        }
      });
    })
    .catch((err) => {
      console.log(`Error en la conversion de XML (movistar) a JSON (movistar)`);
      if (err.error) {
        if (err.error.message) {
          console.log(`  => Error: ${err.error.message}`);
          progPreferences.isConversionRunning = false;
        }
      }
    });

  // Comprobar si la conversión ha finalizado
  // Nota: Se ejecutará inmediatamente (10ms), es un truco
  // para ejecutarlo la primera vez de forma rápida y que él
  // se auto reprograme con el intervalo que desee. 
  timerConversion = setInterval(function () {
    monitorConversion();
  }, 10);

}

// =========================================================
// Monitoriza si la conversión ha finalizado
// =========================================================
function monitorConversion() {
  // Nada más entrar limpio mi timer, lo activaré después
  // si realmente me hace falta. 
  clearInterval(timerConversion);

  // Verifico si sigue activa...
  if (progPreferences.isConversionRunning === false) {
    // Si la conversión termino (con error o correctamente)
    // programo que el session controller se ejecute cuando 
    // le toca...
    console.log(`Programo próxima descarga para el: ${JSON.stringify(progPreferences.nextRunDate.toString())} quedan ${Utils.convertirTiempo(progPreferences.nextRunMilisegundos)}`);
    timerSessionController = setInterval(function () {
      sessionController();
    }, progPreferences.nextRunMilisegundos);
  } else {
    // log
    // console.log(`Monitor: La conversión se está ejecutando`);
    // Me auto-reprogramo para verificar dentro de 500ms.
    timerConversion = setInterval(function () {
      monitorConversion();
    }, 500);
  }
}

// =========================================================
// START...
// =========================================================

// Programo que se arranque el session controller
// Nota: Se ejecutará inmediatamente (10ms), es un truco
// para ejecutarlo la primera vez de forma rápida y que él
// se auto reprograme con el intervalo que desee. 
//
timerSessionController = setInterval(function () {
  sessionController();
}, 10);
