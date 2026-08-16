'use client';

/**
 * "Descargar PDF" = el diálogo de impresión del navegador.
 *
 * No es un atajo: es la decisión. Una librería de PDF son entre 2 y 6 MB de
 * dependencia y un cold start de función serverless para producir un documento
 * que el navegador ya renderiza mejor —con las fuentes del sistema, con su
 * paginación y con vista previa incluida—. El día que haga falta un PDF
 * generado en servidor (para adjuntarlo a un correo), se agrega ahí y esta
 * pantalla no cambia.
 *
 * El botón dice "Guardar como PDF" y no "Imprimir" porque eso es lo que el
 * cliente va a hacer, y llamarlo por su nombre evita el segundo de duda sobre
 * si va a salir papel.
 */

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-xl bg-ink px-4 py-2 text-[13px] font-semibold text-paper transition hover:bg-money-bright"
    >
      Guardar como PDF
    </button>
  );
}
