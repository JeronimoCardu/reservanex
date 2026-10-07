// Tipos compartidos por el inspector de video y sus parsers de contenedor.

export type VideoContainerFamily = 'isobmff' | 'ebml'
export type VideoContainer = 'mp4' | 'quicktime' | 'webm' | 'matroska'

export type VideoInspectionFailure =
  | 'unrecognized_container'     // no es MP4/MOV ni EBML (archivo basura, imagen, etc.)
  | 'truncated_container'        // una estructura promete más bytes de los que tiene el archivo
  | 'malformed_container'        // estructura inválida (tamaños, tipos, campos)
  | 'invalid_timescale'          // mvhd con timescale 0
  | 'duration_unavailable'       // el contenedor no declara una duración verificable
  | 'inspection_budget_exceeded' // se agotó el presupuesto de bytes/lecturas
  | 'read_failed'                // el RangeReader falló o devolvió otra cosa

export type VideoInspection =
  | { ok: true; family: VideoContainerFamily; container: VideoContainer; durationSeconds: number }
  | { ok: false; family: VideoContainerFamily | null; reason: VideoInspectionFailure }

/** Lo que devuelve cada parser de contenedor cuando sale bien. */
export interface ContainerInspection {
  container: VideoContainer
  durationSeconds: number
}

/** Falla de estructura detectada por un parser de contenedor. */
export class ContainerError extends Error {
  constructor(
    readonly reason: Exclude<VideoInspectionFailure, 'read_failed'>,
    message: string,
  ) {
    super(message)
    this.name = 'ContainerError'
  }
}
