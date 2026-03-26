import { URI } from 'vscode-uri';

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum FileChangeType {
  Created = 1,
  Changed = 2,
  Deleted = 3,
}

export class FileSystemError extends Error {
  readonly code = 'FileSystemError';

  private constructor(message: string) {
    super(message);
    this.name = 'FileSystemError';
  }

  static FileNotFound(): FileSystemError {
    return new FileSystemError('FileNotFound');
  }
  static FileExists(): FileSystemError {
    return new FileSystemError('FileExists');
  }
  static FileIsADirectory(): FileSystemError {
    return new FileSystemError('FileIsADirectory');
  }
  static NoPermissions(message?: string): FileSystemError {
    return new FileSystemError(message ?? 'NoPermissions');
  }
}

class SimpleEmitter<T> {
  private readonly listeners = new Set<(e: T) => void>();
  readonly event = (listener: (e: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(data: T): void {
    for (const l of this.listeners) {
      l(data);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class EventEmitter<T> {
  private readonly _emitter = new SimpleEmitter<T>();
  get event(): (listener: (e: T) => void) => { dispose: () => void } {
    return this._emitter.event;
  }
  fire(data: T): void {
    this._emitter.fire(data);
  }
  dispose(): void {
    this._emitter.dispose();
  }
}

class Watcher {
  onDidChange = (_cb: () => void) => ({ dispose: () => {} });
  onDidCreate = (_cb: () => void) => ({ dispose: () => {} });
  onDidDelete = (_cb: () => void) => ({ dispose: () => {} });
  dispose(): void {}
}

export const workspace = {
  createFileSystemWatcher(_pattern: unknown): Watcher {
    return new Watcher();
  },
};

export class RelativePattern {
  constructor(
    readonly _base: unknown,
    readonly pattern: string
  ) {}
}

export type Event<T> = (listener: (e: T) => void) => { dispose: () => void };

export type Uri = URI;

export const Uri = URI;

export type FileChangeEvent = { type: FileChangeType; uri: Uri };

export interface FileStat {
  type: FileType;
  ctime: number;
  mtime: number;
  size: number;
}

export interface FileSystemProvider {
  stat(uri: Uri): Promise<FileStat> | FileStat;
  readDirectory(uri: Uri): Promise<[string, FileType][]>;
  readFile(uri: Uri): Promise<Uint8Array>;
  writeFile(
    uri: Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> | void;
  watch(uri: Uri): { dispose: () => void };
  createDirectory(uri: Uri): Promise<void> | void;
  delete(uri: Uri, options: { readonly recursive: boolean }): Promise<void> | void;
  rename(oldUri: Uri, newUri: Uri, options: { readonly overwrite: boolean }): Promise<void> | void;
}
