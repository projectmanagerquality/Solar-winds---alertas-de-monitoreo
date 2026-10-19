# Ufinet Orion WhatsApp Alert Bot

Sistema automatizado de integración y notificación de alertas para **SolarWinds Orion**, desarrollado específicamente para **Ufinet Nicaragua** por **StinkyPinky**. Consulta periódicamente la API SWIS de Orion para detectar caídas en nodos y aplicaciones, y envía notificaciones estructuradas a un número o grupo de WhatsApp.

---

## Características principales

* **Monitoreo de nodos y aplicaciones:** consulta en paralelo los nodos caídos (`Status = 2`) o inalcanzables (`Status = 12`) y las aplicaciones SAM/APM caídas (`Status = 2`).
* **Alertas inmediatas (por defecto) o con retraso opcional:** por defecto la caída se notifica en el primer sondeo que la detecta (`confirmDownCycles: 1`) y la recuperación igual (`confirmUpCycles: 1`). Si hay equipos que "parpadean", puede elegir el modo con retraso (2 sondeos seguidos, ~1-2 min) durante la configuración inicial o cambiando esas dos claves. Cada evento se avisa una sola vez: caída y, luego, recuperación (con el nombre del equipo y la duración de la caída).
* **Resumen en caídas masivas:** si en un mismo sondeo cambian más de `groupThreshold` entidades (por defecto 5), se envía **un solo mensaje resumen** en lugar de decenas de mensajes, y se respeta una pausa entre envíos.
* **Resistente a fallos de Orion:** si la API de Orion no responde, el bot **no** da por recuperadas las alertas. Tras `orionFailAlertAfter` fallos seguidos avisa una sola vez "Orion no responde" y avisa también cuando se restablece.
* **Estado persistente:** las alertas activas y los mensajes pendientes se guardan en `ufinet_state.json`. Si el proceso o el servidor se reinician, no se repiten alertas ni se pierden recuperaciones. Si WhatsApp está desconectado, los mensajes se encolan y se envían al reconectar.
* **Recuperación automática de WhatsApp:** reconexión ante desconexiones, limpieza de navegadores huérfanos y reinicio del proceso si WhatsApp no vuelve en `waRestartMinutes`.
* **Comando por WhatsApp:** escribir `!estado` en el chat destino devuelve la lista de entidades caídas en ese momento.
* **Capa visual:** 🔴 caída, 🟠 inalcanzable, 🟢 recuperado; hora en zona horaria de Managua.
* **Instalador y servicio de Windows:** el script de PowerShell instala dependencias y registra el bot como servicio (NSSM) o, si no es posible, como tarea programada.
* **Instancia única:** impide que dos copias del bot (por ejemplo, servicio y consola) corran a la vez.
* **Logs con rotación** en `logs\ufinet_bot.log` (5 MB × 3 archivos).

---

## Requisitos del sistema

* **Sistema operativo:** Windows Server o Windows 10/11, con privilegios de Administrador para instalar.
* **Node.js 18 o superior** (LTS recomendado) accesible en el `PATH`.
* **Acceso a red** desde el servidor al puerto de la API SWIS de Orion (por defecto `17774`) y salida a internet.
* **Credenciales:** un usuario de Orion con permisos de **solo lectura**.
* **Opcional:** `winget` o Chocolatey para obtener NSSM automáticamente (ver más abajo).

---

## Estructura del proyecto

El despliegue estándar usa la ruta `C:\UfinetOrionBot`:

| Archivo / carpeta | Descripción |
|---|---|
| `ufinet_orion_whatsapp.js` | Script principal: sondeo a Orion, lógica de alertas y cliente de WhatsApp. |
| `setup_and_run.ps1` | Instalador/actualizador en PowerShell (dependencias, acceso directo, servicio). |
| `package.json` / `package-lock.json` | Dependencias con versión exacta (el lock se genera en la primera instalación). |
| `ufinet_config.json` | Configuración (se genera en el primer arranque). **Contiene la contraseña de Orion.** |
| `ufinet_state.json` | Estado persistente (alertas activas y cola de mensajes). |
| `.wwebjs_auth/` | Sesión de WhatsApp. No borrar salvo que quiera volver a vincular el QR. |
| `logs/` | `ufinet_bot.log` (con rotación) y, si hay servicio NSSM, `service_stdout.log` / `service_stderr.log`. |
| `tools/nssm.exe` | Copia local de NSSM (la crea el instalador). |

---

## Instalación y despliegue

### Paso 1: Preparar los archivos

Deje `ufinet_orion_whatsapp.js`, `setup_and_run.ps1`, `package.json` y `README.md` en una carpeta de trabajo. El instalador los copiará a `C:\UfinetOrionBot` (sin tocar la configuración, el estado ni la sesión de WhatsApp si ya existen).

### Paso 2: Ejecutar el instalador

Abra **PowerShell como Administrador**, entre a la carpeta de trabajo y ejecute:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_and_run.ps1
```

El script copia los archivos, verifica Node.js 18+, instala `whatsapp-web.js`, `qrcode-terminal` y `axios` (con versión exacta), crea el acceso directo del Escritorio y pregunta si desea instalar el servicio.

Parámetro opcional `-Service`: `Ask` (por defecto), `Yes` (instala/actualiza el servicio sin preguntar) o `No` (solo consola).

### Paso 3: Configuración inicial y vinculación de WhatsApp

1. Responda **N** cuando pregunte por el servicio (o use `-Service No`). Si todavía no existe configuración ni sesión de WhatsApp, el instalador **iniciará el bot en consola automáticamente**, aunque responda S.
2. El bot solicitará:
   * URL del servidor Orion (ej.: `monitoreo.example.com`; si pega `https://...` se limpia solo)
   * Puerto de la API SWIS (por defecto `17774`)
   * Usuario y contraseña de solo lectura de Orion (la contraseña no se muestra al escribirla)
   * Destino de WhatsApp: número con código de país (ej.: `50588888888`) o ID de grupo terminado en `@g.us`
   * Si el certificado HTTPS de Orion es autofirmado (S/N)
   * Modo de alertas: **1) inmediato** (por defecto) o **2) con retraso** (espera 2 sondeos seguidos, ~1-2 min, para evitar falsas alarmas por parpadeos)
3. Escanee el código QR con la aplicación de WhatsApp del número emisor. Cuando vea `Cliente de WhatsApp conectado y listo`, presione **Ctrl+C**.

### Paso 4: Instalar como servicio (producción)

Vuelva a ejecutar el instalador y responda **S** (o use `-Service Yes`):

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_and_run.ps1 -Service Yes
```

El instalador obtiene NSSM en este orden:

1. `C:\UfinetOrionBot\tools\nssm.exe`, si ya existe, o `nssm.exe` en el `PATH`.
2. **winget** (`NSSM.NSSM`).
3. **Chocolatey** (`nssm`).
4. Si ninguno está disponible, registra una **tarea programada** de Windows (inicio con el sistema, cuenta SYSTEM, reintento cada minuto). En ese caso, si prefiere NSSM, copie `nssm.exe` en `C:\UfinetOrionBot\tools\` y vuelva a ejecutar con `-Service Yes`.

> No se descarga NSSM desde una URL directa: los sitios de descarga son poco fiables y no se publica un hash verificable en este proyecto. Si usa un `nssm.exe` descargado manualmente, verifique su firma/hash antes de copiarlo.

El servicio `UfinetOrionWhatsAppBot` queda con inicio automático retrasado, reinicio automático ante fallos (15 s), cierre ordenado (hasta 15 s) y logs rotados.

---

## Configuración avanzada (`ufinet_config.json`)

Estas claves se escriben con su valor por defecto al crear el archivo. Si falta alguna, se usa el valor por defecto.

| Clave | Por defecto | Descripción |
|---|---|---|
| `pollIntervalSeconds` | `60` | Segundos entre sondeos a Orion (mínimo 15). |
| `confirmDownCycles` | `1` | Sondeos consecutivos caído antes de alertar. `1` = inmediato; `2` = con retraso (anti-parpadeo). |
| `confirmUpCycles` | `1` | Sondeos consecutivos arriba antes de avisar la recuperación. `1` = inmediato. |
| `groupThreshold` | `5` | Más de N eventos en un sondeo se envían como un solo resumen. |
| `sendDelayMs` | `1500` | Pausa entre mensajes de WhatsApp. |
| `orionFailAlertAfter` | `3` | Sondeos fallidos seguidos antes de avisar "Orion no responde". |
| `monitorApplications` | `true` | `false` si no usa SAM/APM (evita consultas que fallan). |
| `queryTimeoutSeconds` | `20` | Tiempo máximo de cada consulta a Orion. |
| `waRestartMinutes` | `10` | Minutos sin WhatsApp conectado antes de reiniciar el proceso. |
| `allowSelfSigned` | `true` | Acepta certificados autofirmados (sin validar). |
| `caCertPath` | `""` | Ruta a un `.pem`/`.crt` del CA de Orion: **recomendado**; valida el certificado de verdad. |
| `timezone` | `America/Managua` | Zona horaria de las horas mostradas en los mensajes. |

La contraseña también puede proveerse con la variable de entorno `ORION_PASSWORD` (tiene prioridad sobre el archivo).

Tras editar el archivo, reinicie el servicio: `Restart-Service UfinetOrionWhatsAppBot` (o `Stop-ScheduledTask` / `Start-ScheduledTask` si usa la tarea programada).

---

## Mantenimiento y soporte

* **Ver logs en vivo:** `Get-Content C:\UfinetOrionBot\logs\ufinet_bot.log -Tail 50 -Wait`
* **Estado del servicio:** `Get-Service UfinetOrionWhatsAppBot`
* **Cambiar credenciales o destino:** detenga el servicio, edite o elimine `ufinet_config.json`, y ejecute el bot en consola para reconfigurar (o edite el JSON directamente) y reinicie el servicio.
* **Actualizar el bot:** reemplace los archivos de la carpeta de trabajo y ejecute otra vez `setup_and_run.ps1 -Service Yes`.
* **Volver a vincular WhatsApp:** detenga el servicio, borre la carpeta `.wwebjs_auth` y ejecute el bot en consola para escanear un nuevo QR.
* **Desinstalar el servicio:** `C:\UfinetOrionBot\tools\nssm.exe remove UfinetOrionWhatsAppBot confirm` (o `Unregister-ScheduledTask -TaskName UfinetOrionWhatsAppBot -Confirm:$false` si usa la tarea programada).
* **Comando de WhatsApp:** `!estado` (en el chat destino) lista las entidades caídas ahora mismo.

### Solución de problemas

| Síntoma | Causa probable / solución |
|---|---|
| `Ya hay otra instancia del bot en ejecución` | El servicio o la tarea ya están corriendo. Deténgalo antes de usar la consola. |
| `HTTP 401: credenciales inválidas` en el log | Usuario/contraseña de Orion incorrectos o sin permisos. |
| `ECONNREFUSED` / `ETIMEDOUT` | Puerto 17774 bloqueado o URL incorrecta. Pruebe la conexión desde el servidor. |
| El servicio arranca pero no envía nada | Falta vincular el QR. Ejecute el bot en consola una vez. |
| `WhatsApp pide escanear un QR pero no hay consola interactiva` | La sesión caducó o se cerró desde el teléfono. Re-vincule (ver "Volver a vincular WhatsApp"). |
| Falla la consulta de aplicaciones | Orion sin SAM/APM. Ponga `"monitorApplications": false`. |
| No llegan comandos `!estado` | Deben enviarse desde el chat configurado como destino. |

---

## Seguridad

* Use siempre un usuario de Orion de **solo lectura**.
* Para validar de verdad el certificado HTTPS de Orion, exporte el certificado/CA a un archivo `.pem` y póngalo en `caCertPath`.
* Proteja también la sesión de WhatsApp (`.wwebjs_auth`): quien la copie puede usar el número emisor.

---

## Versión anterior (Teams)

La primera versión de este proyecto enviaba las alertas a **Microsoft Teams** con un script en Python. Se conserva en [`teams-legacy/`](teams-legacy/README.md) por si se necesita ese canal. La versión actual (WhatsApp, Node.js) es la que se mantiene en la raíz del repositorio.

---

* **Desarrollado para:** Ufinet, Nicaragua.
* **Autor:** StinkyPinky.
