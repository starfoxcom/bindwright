// Spanish texts for the page: neutral Latin American Spanish, addressing the
// reader as "tú". Every key of index.html and of en.js is here. Terms
// developers use as they are (pull request, commit, push) stay in English.
export default {
  "meta.title": "Bindwright",
  "meta.description": "Bindwright escribe los archivos que Claude Code lee sobre tu proyecto, así sabe cómo "
    + "trabajas desde el primer mensaje.",
  "skip.link": "Ir a la instalación",
  "nav.site": "Sitio",
  "nav.github": "GitHub",
  "nav.language": "Idioma",
  "hero.title": "Deja de explicarle tu proyecto a Claude cada vez.",
  "hero.lede": "Bindwright escribe las reglas que Claude Code lee al inicio de cada sesión y agrega una "
    + "revisión con IA a cada pull request, así cada sesión ya sabe cómo trabajas, y toda la "
    + "configuración es un solo comando.",
  "hero.go": "Instalar Bindwright",
  "hero.source": "Ver en GitHub",
  "hero.figure": "Una sesión grabada",
  "hero.empty": "Aquí se reproduce una sesión real, Claude arreglando el mismo error con y sin Bindwright.",
  "changes.title": "Qué cambia",
  "changes.1.was": "Claude olvida cómo trabajas en cada sesión",
  "changes.1.title": "Claude deja de repetir errores",
  "changes.1.text": "Lee tus reglas al inicio de cada sesión, así las funciones pequeñas y las pruebas "
    + "reales dejan de ser algo que tienes que pedir cada vez.",
  "changes.2.was": "Los cambios se integran sin que nadie los revise",
  "changes.2.title": "Cada pull request se revisa",
  "changes.2.text": "Una IA revisa cada cambio antes de integrarlo, y si la revisión no pasa, nada entra.",
  "changes.3.was": "Cada sesión empieza desde cero",
  "changes.3.title": "Las sesiones siguen donde se quedaron",
  "changes.3.text": "Cada sesión empieza con un plan y termina con una nota para la siguiente, así el "
    + "trabajo sigue justo donde se quedó.",
  "changes.4.was": "Un comando equivocado puede borrar tu rama principal",
  "changes.4.title": "Los comandos peligrosos se bloquean",
  "changes.4.text": "Los push forzados a tu rama principal se detienen antes de ejecutarse, ya que un "
    + "comando equivocado ahí te puede costar días de trabajo.",
  "result.title": "Lo que escribe una configuración",
  "result.note": "Se muestra para el proyecto público de una sola persona con todo activado. La configuración "
    + "lo ajusta al tuyo según tus respuestas.",
  "view.label": "Mostrar",
  "view.overview": "Resumen",
  "files.label": "Archivos",
  "files.back": "&larr; Todos los archivos",
  "command.copy": "Copiar comando",
  "install.title": "Instalar",
  "install.how": "Dos comandos una vez por computadora, y luego uno en cada proyecto. Pega cada uno en "
    + "Claude Code, presiona Enter y espera a que termine antes del siguiente.",
  "install.computer": "En esta computadora, una vez",
  "install.market.title": "Dile a Claude Code de dónde viene Bindwright.",
  "install.market.text": "Esto agrega el marketplace de Bindwright, una lista desde la que Claude Code puede "
    + "instalar. Todavía no instala nada.",
  "install.plugin.title": "Instala Bindwright.",
  "install.plugin.text": "Esto agrega los comandos /bindwright a todos los proyectos de esta computadora, más "
    + "un aviso una vez al día cuando algo esté desactualizado. Todavía no cambia ningún proyecto.",
  "install.project": "En cada proyecto",
  "install.open.title": "Abre Claude Code en la carpeta del proyecto.",
  "install.open.text": "La configuración escribe en la carpeta donde está abierto Claude Code.",
  "install.setup.title": "Ejecuta la configuración.",
  "install.setup.text": "Hace unas preguntas y luego escribe los archivos que encajan. Nada de lo que ya tienes "
    + "cambia sin tu sí.",
  "asks.computer.title": "Se pregunta una vez por computadora",
  "asks.computer.text": "Qué herramienta de búsqueda de código usar, si agregar las reglas de trabajo de "
    + "Bindwright a todos los proyectos, un guardia contra force push en todos los proyectos y qué mods "
    + "agregar. Cámbialas después con /bindwright:setup global.",
  "asks.project.title": "Se pregunta en cada proyecto",
  "asks.project.text": "Quién trabaja en él, de quién es, si es privado o público, si el crédito de la IA "
    + "queda fuera de los commits, qué revisiones corren, cómo escribe y trabaja el asistente, y dónde vive "
    + "el plan: un tablero de GitHub, issues o un archivo de traspaso.",
  "footer.note": "Bindwright funciona con Claude Code. No está hecho ni respaldado por Anthropic, ni afiliado a ella.",

  "group.rules.title": "Reglas que Claude sigue",
  "group.rules.say": "Claude las lee al inicio de cada sesión, así trabaja a tu manera sin que se lo tengas "
    + "que repetir.",
  "group.reviews.title": "Revisión de pull requests",
  "group.reviews.say": "Una IA revisa cada pull request, y nada se integra hasta que la revisión pasa.",
  "group.guards.title": "Protecciones",
  "group.guards.say": "Los comandos peligrosos, como un push forzado a tu rama principal, se detienen antes "
    + "de ejecutarse.",
  "group.sessions.title": "Rutinas de sesión",
  "group.sessions.say": "/session-start planea el trabajo contigo, y /session-close revisa qué está "
    + "terminado de verdad y deja una nota para la próxima vez.",
  "group.checks.title": "Revisiones de código",
  "group.checks.say": "Revisiones que corren antes de cada commit o en cada pull request.",
  "group.issues.title": "Formularios de issues",
  "group.issues.say": "Formularios listos para reportar errores, pedir funciones y planear trabajo.",
  "group.project.title": "Archivos del proyecto",
  "group.project.say": "El archivo principal que Claude lee sobre tu proyecto, más un readme y un "
    + "changelog, y la configuración los combina con los tuyos en vez de reemplazarlos.",
  "group.notes.title": "Notas de Bindwright",
  "group.notes.say": "Tus respuestas, para que una actualización futura respete tus cambios.",
  "group.other.title": "Otros archivos",
  "group.other.say": "Archivos de apoyo que el resto necesita.",

  "rule.architecture.name": "La estructura de tu código",
  "rule.architecture.line": "El código nuevo va en las capas de la estructura que elegiste.",
  "rule.clean-code.name": "Código que un recién llegado entiende",
  "rule.clean-code.line": "Nombres claros y comentarios breves, y sin copias del mismo código.",
  "rule.clean-room.name": "Sala limpia",
  "rule.clean-room.line": "El código inspirado en otro producto nunca lo copia.",
  "rule.code-size.name": "Código pequeño y legible",
  "rule.code-size.line": "Las funciones y los archivos se mantienen cortos para poder seguirlos.",
  "rule.collaboration.name": "Trabajo en equipo",
  "rule.collaboration.line": "Cómo el equipo comparte ramas y responde a las revisiones.",
  "rule.confidentiality.name": "Secretos del cliente",
  "rule.confidentiality.line": "Los secretos del cliente no entran en la memoria de Claude.",
  "rule.git.name": "Historial limpio",
  "rule.git.line": "Mensajes de commit claros y una rama por cambio.",
  "rule.review-tiers.name": "Cómo funcionan las revisiones",
  "rule.review-tiers.line": "Qué revisa la IA y cuándo revisa más a fondo.",
  "rule.security.name": "Ningún secreto se publica",
  "rule.security.line": "Las llaves y contraseñas quedan fuera del código y de todo lo que publicas.",
  "rule.shipped-text.name": "Escritura sencilla",
  "rule.shipped-text.line": "El texto que lee la gente suena escrito por una persona.",
  "rule.task-tracking.name": "Una lista de pendientes visible",
  "rule.task-tracking.line": "Claude lleva una lista de tareas en cualquier trabajo de varios pasos.",
  "rule.testing.name": "Pruebas reales",
  "rule.testing.line": "Las pruebas revisan el código real, casos límite incluidos.",
  "rule.token-efficiency.name": "Menos uso desperdiciado",
  "rule.token-efficiency.line": "Claude busca el código antes de leer archivos completos.",
  "rule.tracker.name": "Seguimiento del trabajo",
  "rule.tracker.line": "El trabajo queda anotado entre sesiones, así nada se pierde.",
  "rule.visual.name": "Cambios visuales en pasos pequeños",
  "rule.visual.line": "Todo lo que la gente ve se construye en partes que revisas a simple vista.",

  "license.MIT": "MIT, libre para que cualquiera la reutilice",
  "license.Apache-2.0": "Apache 2.0, libre para que cualquiera la reutilice",
  "license.BSD-3-Clause": "BSD, libre para que cualquiera la reutilice",
  "license.Proprietary": "todos los derechos reservados",

  "fact.license": "Licencia: {words}",
  "fact.contributing": "Una guía de contribución para el equipo",
  "fact.deep-auto": "Los cambios riesgosos reciben una segunda revisión más a fondo por sí solos",
  "fact.deep-asked": "Una segunda revisión más a fondo corre cuando alguien la pide",
  "fact.docs-auto": "Los cambios solo de documentación se integran sin esperar revisión",
  "fact.review-all": "Cada cambio espera su revisión, documentación incluida",
  "fact.pr-form": "Un formulario de pull request que pregunta qué cambió y por qué",
  "fact.owners": "Revisores asignados por carpeta",
  "fact.precommit": "Revisiones antes de cada commit",
  "fact.ai-commits": "Los commits registran qué trabajo tuvo ayuda de IA",

  "tally": "{parts}, {rules}",
  "tally.parts": { one: "{count} parte", other: "{count} partes" },
  "tally.rules": { one: "{count} regla", other: "{count} reglas" },
  "files.count": "Archivos · {count}",
  "copy.command": "Copiar comando",
  "copy.done": "Copiado",
  "copy.manual": "Selecciona y copia",
  "failure": "Esta parte de la página no pudo cargar ({error}), así que recarga la página para intentarlo "
    + "de nuevo.",
};
