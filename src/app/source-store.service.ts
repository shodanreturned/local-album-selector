import { Injectable } from '@angular/core';

type DirectoryHandle = FileSystemDirectoryHandle;
type FileHandle = FileSystemFileHandle;

export interface AlbumImage {
  id: string;
  name: string;
  url: string;
  file: File;
  handle: FileHandle | null;
  selected: boolean;
}

@Injectable({ providedIn: 'root' })
export class SourceStoreService {
  readonly sourceFolderStorageKey = 'album-selector:source-folder-meta';
  readonly sourceHandleDbName = 'album-selector-db';
  readonly sourceHandleStoreName = 'handles';
  readonly sourceHandleKey = 'source-folder-handle';
  private pendingManualFiles: File[] = [];
  private pendingSourceHandle: DirectoryHandle | null = null;

  get supportsDirectoryPicker(): boolean {
    return 'showDirectoryPicker' in window;
  }

  getDirectoryPicker(): () => Promise<DirectoryHandle> {
    return (window as unknown as { showDirectoryPicker: () => Promise<DirectoryHandle> }).showDirectoryPicker;
  }

  async loadImagesFromDirectoryHandle(rootHandle: DirectoryHandle): Promise<AlbumImage[]> {
    const fileHandles = await this.collectImageHandles(rootHandle);
    const allImages = await Promise.all(
      fileHandles.map(async (handle, index) => {
        const file = await handle.getFile();
        return {
          id: `${index}-${file.name}`,
          name: file.name,
          url: URL.createObjectURL(file),
          file,
          handle,
          selected: false,
        };
      }),
    );

    allImages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return allImages;
  }

  async persistSourceFolder(handle: DirectoryHandle): Promise<void> {
    localStorage.setItem(this.sourceFolderStorageKey, JSON.stringify({ name: handle.name }));
    const db = await this.openSourceHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.sourceHandleStoreName, 'readwrite');
      const store = tx.objectStore(this.sourceHandleStoreName);
      store.put(handle, this.sourceHandleKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async getPersistedSourceHandle(): Promise<{ handle: DirectoryHandle | null; name: string }> {
    const raw = localStorage.getItem(this.sourceFolderStorageKey);
    if (!raw) {
      return { handle: null, name: 'no folder selected' };
    }

    const meta = JSON.parse(raw) as { name?: string };
    const sourceName = meta.name ?? 'restored source';
    const db = await this.openSourceHandleDb();
    const handle = await new Promise<DirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(this.sourceHandleStoreName, 'readonly');
      const store = tx.objectStore(this.sourceHandleStoreName);
      const request = store.get(this.sourceHandleKey);
      request.onsuccess = () => resolve((request.result as DirectoryHandle | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { handle, name: sourceName };
  }

  async clearPersistedSourceFolder(): Promise<void> {
    localStorage.removeItem(this.sourceFolderStorageKey);
    const db = await this.openSourceHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.sourceHandleStoreName, 'readwrite');
      const store = tx.objectStore(this.sourceHandleStoreName);
      store.delete(this.sourceHandleKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  revokeImageUrls(images: AlbumImage[]): void {
    for (const image of images) {
      URL.revokeObjectURL(image.url);
    }
  }

  setPendingManualFiles(files: File[]): void {
    this.pendingManualFiles = [...files];
  }

  consumePendingManualFiles(): File[] {
    const files = [...this.pendingManualFiles];
    this.pendingManualFiles = [];
    return files;
  }

  setPendingSourceHandle(handle: DirectoryHandle): void {
    this.pendingSourceHandle = handle;
  }

  consumePendingSourceHandle(): DirectoryHandle | null {
    const handle = this.pendingSourceHandle;
    this.pendingSourceHandle = null;
    return handle;
  }

  private async collectImageHandles(directory: DirectoryHandle): Promise<FileHandle[]> {
    const images: FileHandle[] = [];
    const walk = async (folder: DirectoryHandle): Promise<void> => {
      const directoryEntries = folder as unknown as AsyncIterable<[string, FileSystemHandle]>;
      for await (const [, handle] of directoryEntries) {
        if (handle.kind === 'directory') {
          await walk(handle as DirectoryHandle);
          continue;
        }

        const fileHandle = handle as FileHandle;
        const lower = fileHandle.name.toLowerCase();
        if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
          images.push(fileHandle);
        }
      }
    };
    await walk(directory);
    return images;
  }

  private async openSourceHandleDb(): Promise<IDBDatabase> {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.sourceHandleDbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.sourceHandleStoreName)) {
          db.createObjectStore(this.sourceHandleStoreName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}
