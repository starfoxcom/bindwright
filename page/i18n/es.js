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
  "files.label": "Archivos",
  "files.back": "&larr; Todos los archivos",
  "files.browse": { one: "Ver el {count} archivo", other: "Ver los {count} archivos" },
  "files.hide": "Ocultar los archivos",
  "command.copy": "Copiar comando",
  "install.title": "Instalar",
  "install.how": "Dos comandos una vez en tu computadora, y luego uno en cada proyecto. Pega cada uno en "
    + "Claude Code, presiona Enter y espera a que termine antes del siguiente.",
  "install.computer": "En tu computadora, una vez",
  "install.market.title": "Dile a Claude Code de dónde viene Bindwright.",
  "install.market.text": "Esto agrega el marketplace de Bindwright, una lista desde la que Claude Code puede "
    + "instalar. Todavía no instala nada.",
  "install.plugin.title": "Instala Bindwright.",
  "install.plugin.text": "Esto agrega los comandos /bindwright a todos los proyectos de tu computadora, más "
    + "un aviso una vez al día cuando algo esté desactualizado. Todavía no cambia ningún proyecto.",
  "install.project": "En cada proyecto",
  "install.open.title": "Abre Claude Code en la carpeta del proyecto.",
  "install.open.text": "La configuración escribe en la carpeta donde está abierto Claude Code.",
  "install.setup.title": "Ejecuta la configuración.",
  "install.setup.text": "Hace unas preguntas y luego escribe los archivos que encajan. Nada de lo que ya tienes "
    + "cambia sin tu sí.",
  "asks.computer.title": "Se pregunta una vez en tu computadora",
  "asks.computer.text": "Qué herramienta de búsqueda de código usar, si agregar las reglas de trabajo de "
    + "Bindwright a todos los proyectos, un guardia contra force push en todos los proyectos, si un "
    + "modelo ayudante barato escribe el código que planea el modelo principal, si aprender tu estilo de "
    + "código del código que escribiste a mano y qué mods agregar. "
    + "Cámbialas después con /bindwright:setup global.",
  "asks.project.title": "Se pregunta en cada proyecto",
  "asks.project.text": "Quién trabaja en él, de quién es, si es privado o público, si el crédito de la IA "
    + "queda fuera de los commits, qué revisiones corren, cómo escribe y trabaja el asistente, y dónde vive "
    + "el plan: un tablero de GitHub, issues o un archivo de traspaso.",
  "footer.note": "Bindwright funciona con Claude Code. No está hecho ni respaldado por Anthropic, ni afiliado a ella.",

  "copy.command": "Copiar comando",
  "copy.done": "Copiado",
  "copy.manual": "Selecciona y copia",
  "failure": "Esta parte de la página no pudo cargar ({error}), así que recarga la página para intentarlo "
    + "de nuevo.",

  "scene.aria": "Una sesión de programación en la terminal con Bindwright configurado",
  "scene.placeholder": "Lo que hace Bindwright aparece aquí",
  "scene.guard.title": "Guardia de push",
  "scene.guard.text": "Detuvo un push forzado a main antes de que llegara a GitHub.",
  "scene.guard.chip": "Cada proyecto en tu computadora",
  "scene.review.title": "Control de revisión",
  "scene.review.open": "1 hallazgo: la cantidad puede faltar",
  "scene.review.done": "Limpio. Integrado en develop",
  "scene.review.chip": "Revisión con IA en cada PR",
  "scene.handoff.title": "Nota de traspaso",
  "scene.handoff.done": "Hecho",
  "scene.handoff.done.item": "#12 total del carrito",
  "scene.handoff.next": "Sigue",
  "scene.handoff.next.item": "#14 códigos de descuento",
  "scene.handoff.watch": "Vigilar",
  "scene.handoff.watch.item": "redondeo de impuestos",
  "scene.caption.1": "Arranca desde tu tablero",
  "scene.caption.2": "Escribe el código y corre las pruebas",
  "scene.caption.3": "Las protecciones frenan lo riesgoso",
  "scene.caption.4": "Cada PR recibe una revisión con IA",
  "scene.caption.5": "Deja una nota para la próxima vez",
  "scene.say.next": "Dos pendientes en el tablero. Lo siguiente: <b>#12 Arreglar el total del carrito</b>.",
  "scene.todo.1": "Escribir una prueba que falle",
  "scene.todo.2": "Arreglar el total",
  "scene.todo.3": "Abrir el PR",
  "scene.blocked": "Bloqueado por Bindwright: no se permite force push a main.",
  "scene.blocked.fix": "Sube la rama y abre un PR en su lugar.",
  "scene.next": "Sigue: #14 códigos de descuento",
  "scene.verb.reading": "Leyendo el tablero",
  "scene.verb.thinking": "Pensando",
  "scene.verb.handoff": "Escribiendo el traspaso",

  "lands.aria": "Una terminal con /bindwright:setup, donde cada archivo que escribe vuela a una de "
    + "dos cajas",
  "lands.computer.title": "Tu computadora",
  "lands.computer.tag": "Se pregunta una vez",
  "lands.project.title": "Este proyecto",
  "lands.project.tag": "Se pregunta en cada proyecto",
  "lands.item.plugin": "Plugin de Bindwright",
  "lands.item.global-rules": "Reglas de trabajo para cada proyecto",
  "lands.item.memory": "Índice de memoria",
  "lands.item.guard": "Guardia de push",
  "lands.item.builder": "Ayudante que escribe código",
  "lands.item.mods": "Mods que elegiste",
  "lands.item.brief": "Guía del proyecto",
  "lands.item.rules": "Reglas",
  "lands.item.routines": "Rutinas de sesión",
  "lands.item.guards": "Guardias",
  "lands.item.review": "Revisión con IA en cada PR",
  "lands.item.board": "Ajustes del tablero de trabajo",
  "lands.verb": "Haciendo las preguntas",
  "lands.say.first": "Primera vez en esta computadora: primero hace las preguntas de la "
    + "computadora, una sola vez, y luego las del proyecto.",
  "lands.say.done": "Listo. Cambia las opciones de la computadora cuando quieras con "
    + "/bindwright:setup global.",
  "evidence.title": "Lo que detectó en proyectos reales",
  "evidence.note": "Bindwright pone un revisor de IA en cada pull request. "
    + "Estos son sus resultados en cinco proyectos, de septiembre a noviembre de 2026.",
  "evidence.reviewed": "pull requests que la IA revisó antes de integrarse",
  "evidence.stopped": "tenían un problema que la IA detectó y se detuvieron hasta corregirlo",
  "evidence.deep": "tocaban código riesgoso, como seguridad o datos guardados, "
    + "y recibieron una segunda revisión más a fondo",
  "evidence.chart": "Por proyecto: pull requests revisados y cuántos tenían un problema detectado",
  "evidence.stories": "Errores que se volvieron reglas",
  "evidence.wrong": "Qué salió mal",
  "evidence.now": "Qué hace Bindwright ahora",
  "evidence.project.game": "GameProject",
  "evidence.project.this": "Este proyecto",
  "evidence.project.business": "BusinessApp",
  "evidence.project.language": "LanguageApp",
  "evidence.project.community": "CommunityApp",
  "evidence.checked": { one: "{count} revisado", other: "{count} revisados" },
  "evidence.caught": { one: "{count} detectado", other: "{count} detectados" },
  "evidence.legend.passed": "pasaron la revisión",
  "evidence.legend.fixed": "tenían un problema, corregido antes de integrarse",
  "evidence.story1.where": "GameProject",
  "evidence.story1.was": "El tablero de tareas del proyecto quedó público, con cada nota interna de ingeniería.",
  "evidence.story1.now": "Revisa la visibilidad del tablero en cada lectura y te avisa si es público.",
  "evidence.story2.where": "Este proyecto",
  "evidence.story2.was": "Un cambio subió funciones de 273 líneas porque la regla "
    + "que limita su tamaño nunca se cargó.",
  "evidence.story2.now": "Una revisión de tamaño corre en cada pull request y falla si una función crece demasiado.",

  "nav.settings": "Ajustes",
  "asks.more": "Ver todos los ajustes",
  "settings.meta.title": "Todos los ajustes · Bindwright",
  "settings.meta.description": "Cada ajuste que pregunta o completa la instalación de Bindwright: "
    + "las opciones de tu computadora, las que se preguntan en cada proyecto y los valores por defecto.",
  "settings.skip": "Ir a los ajustes",
  "settings.title": "Cada ajuste",
  "settings.lede": "La instalación hace dos tipos de preguntas. Las opciones de tu computadora se "
    + "preguntan una vez y valen para todos los proyectos de tu computadora. Las opciones del proyecto "
    + "se preguntan en cada proyecto y solo aplican a ese repo.",
  "settings.computer.title": "Una vez en tu computadora",
  "settings.computer.where": "Se guarda en <code>~/.claude/bindwright/settings.json</code>. Cámbialas con "
    + "<code>/bindwright:setup global</code>.",
  "settings.project.title": "En cada proyecto",
  "settings.project.where": "Se guarda en <code>.bindwright/project.json</code> del repo. Vuelve a correr "
    + "<code>/bindwright:setup</code> en ese proyecto para cambiarlas.",
  "settings.fixed.title": "No se pregunta, trae un valor por defecto",
  "settings.fixed.where": "Salen de tus respuestas o quedan en un valor por defecto. Cámbialas en "
    + "<code>.bindwright/project.json</code> y luego corre <code>/bindwright:update</code>.",
  "settings.mods-group.title": "Mods",
  "settings.mods-group.text": "Pequeños complementos para Claude Code que muestran el estado en vivo y "
    + "agregan comandos. Necesitan CLI 2.1.287 o más reciente y Node, y tú eliges cuáles agregar.",

  "settings.code-research.title": "Herramienta de búsqueda de código",
  "settings.code-research.text": "Cómo encuentra el asistente el código de tus proyectos. La instalación "
    + "instala la que elijas e indexa cada proyecto. Opciones: tokensave, lsp-plugins, codegraph, serena, "
    + "codebase-memory o none.",
  "settings.code-research.value": "tokensave (recomendado)",
  "settings.global-instructions.title": "Instrucciones globales",
  "settings.global-instructions.text": "Un conjunto corto de reglas de trabajo que lee cada proyecto de tu "
    + "computadora, agregado a ~/.claude/CLAUDE.md.",
  "settings.global-instructions.value": "Sí (recomendado)",
  "settings.push-guard.title": "Guardia de push en todos los proyectos",
  "settings.push-guard.text": "Bloquea los force push en cada repo de tu computadora, incluso en los que "
    + "Bindwright nunca configuró.",
  "settings.push-guard.value": "Sí (recomendado)",
  "settings.builder.title": "Agente constructor",
  "settings.builder.text": "Un ayudante con el modelo Haiku, pequeño y barato, escribe el código a partir de "
    + "una instrucción corta, mientras el modelo principal planea, corre las pruebas, revisa el diff y hace "
    + "los commits. Cuesta una fracción de lo que costaría que el modelo principal haga el mismo trabajo. "
    + "Si eliges no, todo el trabajo se queda en la sesión principal.",
  "settings.builder.value": "Sí (recomendado)",
  "settings.code-style.title": "Perfil de estilo de código",
  "settings.code-style.text": "Con tu permiso, lee el código que escribiste a mano, en repos locales y en tu "
    + "cuenta de GitHub, y guarda un perfil corto de cómo escribes. Los puntos débiles se llevan a la "
    + "práctica actual, y cada sesión lo sigue.",
  "settings.code-style.value": "Sí (recomendado), ahora o después",

  "settings.who-works.title": "Quién trabaja en él",
  "settings.who-works.text": "Solo tú, o un equipo. Un equipo recibe las reglas de colaboración y un hook "
    + "de pre-commit.",
  "settings.who-works.value": "Solo yo",
  "settings.whose-project.title": "De quién es el proyecto",
  "settings.whose-project.text": "Tuyo, o de alguien más, como un cliente o un empleador. Si es de alguien "
    + "más, recibe una licencia propietaria y, si es privado, una regla de confidencialidad.",
  "settings.whose-project.value": "Mío",
  "settings.visibility.title": "Privado o público",
  "settings.visibility.text": "Si el código está abierto a todos en GitHub o es privado para ti y tu equipo.",
  "settings.visibility.value": "Público para el tuyo, privado para el de alguien más",
  "settings.ai-credit.title": "Crédito de la IA en los commits",
  "settings.ai-credit.text": "Quedar fuera significa que los commits, pull requests y comentarios no llevan "
    + "líneas de 'generado con' ni crédito de coautor de la IA, y una guardia lo bloquea.",
  "settings.ai-credit.value": "Fuera",
  "settings.ai-review.title": "Revisión con IA en cada pull request",
  "settings.ai-review.text": "Un revisor de IA revisa cada pull request antes de integrarse.",
  "settings.ai-review.value": "Activada",
  "settings.deep-review.title": "Revisión más profunda en cambios riesgosos",
  "settings.deep-review.text": "Los cambios que tocan código riesgoso, como seguridad o datos guardados, "
    + "reciben una segunda revisión más a fondo. Necesita la revisión con IA.",
  "settings.deep-review.value": "Activada",
  "settings.code-size.title": "Revisión de tamaño del código",
  "settings.code-size.text": "Una revisión que falla cuando el código crece más allá de los límites de tamaño.",
  "settings.code-size.value": "Activada",
  "settings.plain-writing.title": "Escritura en lenguaje claro",
  "settings.plain-writing.text": "Respuestas, docs y texto de commits en palabras sencillas que intentan sonar "
    + "como si lo hubieras escrito tú (sigue siendo una IA la que lo escribe ;V).",
  "settings.plain-writing.value": "Activada",
  "settings.visual-steps.title": "Cambios visuales en pasos chicos",
  "settings.visual-steps.text": "Los cambios a lo que la gente ve se hacen en pasos chicos, y cada uno se "
    + "revisa antes del siguiente.",
  "settings.visual-steps.value": "Activada",
  "settings.work-state.title": "Dónde vive el estado del trabajo",
  "settings.work-state.text": "Un tablero de GitHub con los issues y una nota corta de traspaso, solo issues "
    + "de GitHub, o un archivo de traspaso detallado en el repo.",
  "settings.work-state.value": "Tablero de GitHub y una nota corta de traspaso",
  "settings.work-items-repo.title": "Repo privado para los pendientes",
  "settings.work-items-repo.text": "Solo se pregunta cuando el código es público, porque los issues de un repo "
    + "público también son públicos. Guarda los pendientes en un repo privado.",
  "settings.work-items-repo.value": "Sí (recomendado)",
  "settings.board-visibility.title": "Visibilidad del tablero",
  "settings.board-visibility.text": "El tablero tiene todos los detalles de ingeniería y se queda privado. Una "
    + "copia pública limpia para gente de fuera es opcional, y hacer público el tablero completo muestra "
    + "antes una advertencia clara.",
  "settings.board-visibility.value": "Privado",

  "settings.name-and-repo.title": "Nombre del proyecto, dirección del repo y titular de la licencia",
  "settings.name-and-repo.text": "Se leen de la carpeta del repo, su remoto de git y tu nombre en git.",
  "settings.name-and-repo.value": "Se lee del repo",
  "settings.license.title": "Licencia",
  "settings.license.text": "Sale de tus respuestas: MIT para tu proyecto público, propietaria en otro caso.",
  "settings.license.value": "MIT o propietaria",
  "settings.branching.title": "Ramas",
  "settings.branching.text": "Gitflow: main para las versiones y develop para el trabajo. main sigue siendo la "
    + "rama predeterminada en GitHub.",
  "settings.branching.value": "Gitflow",
  "settings.merge-style.title": "Estilo de merge",
  "settings.merge-style.text": "Cada pull request se integra con un commit de merge, así cada rama sigue "
    + "visible en el historial.",
  "settings.merge-style.value": "Commits de merge",
  "settings.pre-commit.title": "Hook de pre-commit",
  "settings.pre-commit.text": "Ninguno solo. Un equipo recibe lefthook, que corre revisiones antes de cada "
    + "commit.",
  "settings.pre-commit.value": "Ninguno solo, lefthook para un equipo",
  "settings.guard-location.title": "Dónde viven las guardias",
  "settings.guard-location.text": "En el repo, así todo el que lo clone las recibe. La otra opción las pone solo "
    + "en el ~/.claude de cada persona.",
  "settings.guard-location.value": "En el repo",
  "settings.blocked-commands.title": "Comandos bloqueados",
  "settings.blocked-commands.text": "La lista estándar de comandos que el asistente nunca puede correr.",
  "settings.blocked-commands.value": "Estándar",
  "settings.architecture.title": "Regla de arquitectura",
  "settings.architecture.text": "Una estructura de carpetas opcional que sigue el asistente: none, clean, ddd, "
    + "ecs, feature-based, hexagonal, layered o mvc.",
  "settings.architecture.value": "Ninguna",
  "settings.confidentiality.title": "Regla de confidencialidad",
  "settings.confidentiality.text": "Se agrega para un proyecto privado de alguien más, donde el asistente sigue "
    + "una regla de confidencialidad.",
  "settings.confidentiality.value": "Activada para un proyecto privado de alguien más",
  "settings.clean-room.title": "Regla de clean room",
  "settings.clean-room.text": "Para proyectos derivados de un trabajo existente. Mantiene limpio lo que se "
    + "entrega, sin material copiado.",
  "settings.clean-room.value": "Desactivada",
  "settings.shipped-text.title": "Archivos que revisa la regla de escritura",
  "settings.shipped-text.text": "Los archivos que revisa la regla de escritura en lenguaje claro. La "
    + "instalación usa la lista propia de la regla.",
  "settings.shipped-text.value": "La lista de la regla",

  "mods.session-facts.title": "<code>session-facts</code>",
  "mods.session-facts.text": "Le dice al asistente la hora, qué tan lleno está su contexto y el uso de tu plan "
    + "en cada prompt, y te muestra lo mismo en una fila sobre el prompt.",
  "mods.session-facts.value": "Recomendado",
  "mods.compact-handoff.title": "<code>compact-handoff</code>",
  "mods.compact-handoff.text": "Convierte la compactación en un traspaso enfocado y agrega una herramienta de "
    + "recuperación que busca en toda la transcripción después.",
  "mods.compact-handoff.value": "Opcional",
  "mods.ci-watch.title": "<code>ci-watch</code>",
  "mods.ci-watch.text": "Después de un push, vigila las revisiones del pull request y despierta la sesión "
    + "cuando todas terminan.",
  "mods.ci-watch.value": "Opcional",
  "mods.runners.title": "<code>runners</code>",
  "mods.runners.text": "Muestra una fila por cada runner de CI local que listes: si está corriendo, cuándo es "
    + "su siguiente corrida, con botones de iniciar y detener.",
  "mods.runners.value": "Opcional",
  "mods.shared-pc.title": "<code>shared-pc</code>",
  "mods.shared-pc.text": "Deja que una sesión a la vez tenga la computadora para trabajo pesado, como "
    + "compilaciones y suites de pruebas completas; las demás esperan en una fila visible.",
  "mods.shared-pc.value": "Opcional",
  "mods.skill-check.title": "<code>skill-check</code>",
  "mods.skill-check.text": "Revisa que una habilidad haya corrido cada paso que exige su contrato, y pide los "
    + "que se saltó.",
  "mods.skill-check.value": "Opcional",
  "mods.tasks.title": "<code>tasks</code>",
  "mods.tasks.text": "Mantiene la lista de tareas honesta: una tarea en progreso, una lista que sobrevive a la "
    + "compactación y un recordatorio para seguir cuando queda trabajo.",
  "mods.tasks.value": "Opcional",
  "mods.usage-guard.title": "<code>usage-guard</code>",
  "mods.usage-guard.text": "Cerca de un límite del plan, hace que cada sesión guarde su trabajo y luego las "
    + "reanuda cuando el límite se reinicia.",
  "mods.usage-guard.value": "Opcional",
  "mods.session-info.title": "<code>session-info</code>",
  "mods.session-info.text": "Agrega una fila sobre el prompt con el modelo, el proyecto, la rama de git y los "
    + "archivos cambiados.",
  "mods.session-info.value": "Opcional",
  "mods.mods.title": "<code>mods</code>",
  "mods.mods.text": "Abre un panel con cada mod instalado, qué hace y los comandos que agrega.",
  "mods.mods.value": "Opcional",
};
