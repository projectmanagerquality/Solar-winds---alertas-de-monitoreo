# Orion → Teams Monitor

Script en Python que consulta **SolarWinds Orion** (API SWIS) y envía una alerta a **Microsoft Teams** cuando un nodo o aplicación se cae, y otra cuando se recupera. Solo requiere un usuario de **solo lectura** en Orion.

## Cómo funciona

1. Cada `POLL_SECONDS` (60 por defecto) consulta a Orion:
   - **Nodos** con estado `Down` (2) o `Unreachable` (12).
   - **Aplicaciones** (APM/SAM) con estado `Down` (2).
2. Compara contra el estado anterior guardado en `orion_state.json`.
3. Si hay servicios nuevos caídos, envía una Adaptive Card roja a Teams. Si alguno se recuperó, envía una verde.
4. Solo notifica en cambios de estado, no repite la alerta en cada ciclo.
5. Si Orion no responde, registra el error en consola y reintenta en el siguiente ciclo.

## Requisitos

- Python 3.8+
- Acceso de red desde la PC a Orion por el puerto **17774** (API SWIS)
- Usuario de solo lectura en Orion
- Un webhook de Teams (Workflows)

```bash
pip install -r requirements.txt
```

## Configuración

Se hace con variables de entorno:

| Variable        | Obligatoria | Descripción                                                         |
|-----------------|-------------|---------------------------------------------------------------------|
| `ORION_HOST`    | Sí          | Host de Orion, ej. `monitoreo.example.com`                          |
| `ORION_USER`    | Sí          | Usuario de solo lectura                                             |
| `ORION_PASS`    | Sí          | Contraseña                                                          |
| `TEAMS_WEBHOOK` | Sí          | URL del flujo de Teams                                              |
| `POLL_SECONDS`  | No          | Intervalo de consulta en segundos (default `60`)                    |
| `VERIFY_TLS`    | No          | `0` para aceptar certificados internos o autofirmados (default `1`) |

### Crear el webhook de Teams

1. En Teams abre **Workflows**.
2. Usa la plantilla *Publicar en un canal cuando se recibe una solicitud de webhook*.
3. Elige el canal y copia la URL generada.

### Windows (PowerShell)

```powershell
setx ORION_HOST "monitoreo.example.com"
setx ORION_USER "usuario_lectura"
setx ORION_PASS "tu_clave"
setx TEAMS_WEBHOOK "https://...url-del-flujo..."
setx VERIFY_TLS "0"
```

Abre una terminal nueva después de correr `setx`.

## Uso

Verifica primero la conectividad con la API:

```powershell
Test-NetConnection monitoreo.example.com -Port 17774
```

Ejecuta el monitor:

```bash
python orion_teams_monitor.py
```

Para forzar una alerta de prueba, borra `orion_state.json` mientras haya algo caído.

## Ejecución permanente en Windows

Ejecuta esto en PowerShell como administrador, ajustando la ruta:

```powershell
$a = New-ScheduledTaskAction -Execute "python" -Argument "C:\OrionMonitor\orion_teams_monitor.py" -WorkingDirectory "C:\OrionMonitor"
$t = New-ScheduledTaskTrigger -AtStartup
$s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "OrionTeamsMonitor" -Action $a -Trigger $t -Settings $s -User $env:USERNAME -RunLevel Limited
```

La tarea arranca con Windows y se reinicia si el script falla.

## Personalización

Las consultas están en el diccionario `QUERIES` de `orion_teams_monitor.py`. Son consultas SWQL, por ejemplo:

```sql
-- Solo nodos de un grupo/ubicación concreta
SELECT NodeID AS Id, Caption AS Name, IPAddress AS Extra, Status
FROM Orion.Nodes WHERE Status IN (2, 12) AND Location = 'Managua'
```

## Seguridad

- No guardes credenciales en el código ni en el repositorio.
- Usa una cuenta de Orion con permisos de solo lectura.
- Trata la URL del webhook de Teams como un secreto: cualquiera que la tenga puede publicar en el canal.
- `orion_state.json` está en `.gitignore`.

## Limitaciones

- No avisa a Teams si Orion mismo deja de responder (solo lo registra en consola).
- No incluye estados `Warning` (3). Para agregarlos, incluye `3` en las consultas.
- No probado contra todas las versiones de Orion; las entidades `Orion.Nodes` y `Orion.APM.Application` pueden variar según módulos instalados.
