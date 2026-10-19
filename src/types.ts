/**
 * Core types shared across the extension.
 *
 * `SpaceConfigEntry` mirrors what users write in the `codeFolderSpaces.spaces`
 * setting: either a plain path string or a richer object.
 */

export interface SpaceConfigObject {
  /** Folder path (absolute or using supported variables). */
  path?: string;
  /** Display name; defaults to the folder basename. */
  name?: string;
  /** ThemeIcon id (e.g. `folder`) or absolute path to an SVG/PNG icon. */
  icon?: string;
  /** Per-space override for showing files in the tree. */
  showFiles?: boolean;
  /** Optional glob patterns; only matching files are shown. */
  include?: string[];
  /** Optional glob patterns; matching files and folders are hidden. */
  exclude?: string[];
}

export type SpaceConfigEntry = string | SpaceConfigObject;

export type SpaceOrigin = 'workspace' | 'global';

/** A validated, resolved space ready for the tree provider. */
export interface SpaceDefinition {
  /** Normalized absolute folder path. */
  basePath: string;
  /** Display name. */
  name: string;
  /** Optional icon override. */
  icon?: string;
  /** Whether files are shown next to folders. */
  showFiles: boolean;
  /** Include globs applied to files (empty = include everything). */
  include: string[];
  /** Exclude globs applied to files and folders. */
  exclude: string[];
  /** Index in the raw configuration array (stable identity for edits). */
  sourceIndex: number;
  /** Which settings layer this definition came from; missing means workspace. */
  origin?: SpaceOrigin;
}
