import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';

type DirectoryHandle = FileSystemDirectoryHandle;
type FileHandle = FileSystemFileHandle;

interface AlbumImage {
  id: string;
  name: string;
  url: string;
  file: File;
  handle: FileHandle | null;
  selected: boolean;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('imageFilesInput') private imageFilesInput?: ElementRef<HTMLInputElement>;

  private readonly selectedNumbersStorageKey = 'album-selector:selected-image-numbers';
  private readonly sourceFolderStorageKey = 'album-selector:source-folder-meta';
  private readonly sourceHandleDbName = 'album-selector-db';
  private readonly sourceHandleStoreName = 'handles';
  private readonly sourceHandleKey = 'source-folder-handle';
  private readonly batchSize = 80;
  private readonly doubleTapMs = 280;
  private pendingTapTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTapImageId: string | null = null;
  private destinationHandle: DirectoryHandle | null = null;

  allImages: AlbumImage[] = [];
  visibleCount = this.batchSize;
  isLoading = false;
  errorMessage = '';
  isSelectingDestination = false;
  showSelectedOnly = false;
  fullscreenImageUrl: string | null = null;
  fullscreenImageName = '';
  infoMessage = '';

  get supportsDirectoryPicker(): boolean {
    return 'showDirectoryPicker' in window;
  }

  get selectedCount(): number {
    return this.allImages.filter((image) => image.selected).length;
  }

  get filteredImages(): AlbumImage[] {
    const source = this.showSelectedOnly
      ? this.allImages.filter((image) => image.selected)
      : this.allImages;
    return source.slice(0, this.visibleCount);
  }

  get canLoadMore(): boolean {
    const max = this.showSelectedOnly
      ? this.selectedCount
      : this.allImages.length;
    return this.visibleCount < max;
  }

  ngOnInit(): void {
    void this.tryRestoreSourceFolder();
  }

  ngOnDestroy(): void {
    this.clearPendingTap();
    this.revokeAllUrls();
  }

  async pickDirectory(): Promise<void> {
    this.errorMessage = '';
    if (!this.supportsDirectoryPicker) {
      this.imageFilesInput?.nativeElement.click();
      return;
    }

    try {
      this.isLoading = true;
      this.showSelectedOnly = false;
      this.visibleCount = this.batchSize;
      this.revokeAllUrls();
      this.allImages = [];
      this.destinationHandle = null;

      const rootHandle = await this.getDirectoryPicker()();
      await this.loadImagesFromDirectoryHandle(rootHandle);
      await this.persistSourceFolder(rootHandle);
    } catch (error) {
      this.errorMessage = this.readError(error, 'Unable to open folder.');
    } finally {
      this.isLoading = false;
    }
  }

  onFilesChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (!files.length) {
      return;
    }

    this.errorMessage = '';
    this.infoMessage = '';
    this.showSelectedOnly = false;
    this.visibleCount = this.batchSize;
    this.revokeAllUrls();
    this.destinationHandle = null;
    void this.clearSourceFolderStorage();

    this.allImages = files
      .filter((file) => {
        const lower = file.name.toLowerCase();
        return lower.endsWith('.jpg') || lower.endsWith('.jpeg');
      })
      .map((file, index) => ({
        id: `${index}-${file.name}`,
        name: file.name,
        url: URL.createObjectURL(file),
        file,
        handle: null,
        selected: false,
      }));

    this.allImages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    this.restoreSelectionFromStorage();
    input.value = '';
  }

  onGridScroll(event: Event): void {
    const element = event.target as HTMLElement;
    const nearBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 200;
    if (nearBottom && this.canLoadMore) {
      this.visibleCount += this.batchSize;
    }
  }

  onImageTap(image: AlbumImage): void {
    if (this.pendingTapImageId === image.id && this.pendingTapTimer) {
      clearTimeout(this.pendingTapTimer);
      this.pendingTapTimer = null;
      this.pendingTapImageId = null;
      this.openFullscreen(image);
      return;
    }

    this.clearPendingTap();
    this.pendingTapImageId = image.id;
    this.pendingTapTimer = setTimeout(() => {
      image.selected = !image.selected;
      this.persistSelectionToStorage();
      this.pendingTapTimer = null;
      this.pendingTapImageId = null;
    }, this.doubleTapMs);
  }

  toggleSelectedOnly(): void {
    this.showSelectedOnly = !this.showSelectedOnly;
    this.visibleCount = this.batchSize;
  }

  clearSelection(): void {
    for (const image of this.allImages) {
      image.selected = false;
    }
    if (this.showSelectedOnly) {
      this.visibleCount = this.batchSize;
    }
    localStorage.removeItem(this.selectedNumbersStorageKey);
    this.infoMessage = 'Selection cleared.';
  }

  closeFullscreen(): void {
    this.fullscreenImageUrl = null;
    this.fullscreenImageName = '';
  }

  async finaliseSelection(): Promise<void> {
    this.errorMessage = '';
    this.infoMessage = '';
    const selected = this.allImages.filter((image) => image.selected);
    if (!selected.length) {
      this.errorMessage = 'Select at least one image before finalising.';
      return;
    }

    if (!this.supportsDirectoryPicker) {
      this.downloadSelectedImages(selected);
      this.infoMessage = `Downloaded ${selected.length} selected image${selected.length === 1 ? '' : 's'}.`;
      return;
    }

    try {
      this.isSelectingDestination = true;
      if (!this.destinationHandle) {
        this.destinationHandle = await this.getDirectoryPicker()();
      }

      for (const image of selected) {
        const sourceFile = image.handle ? await image.handle.getFile() : image.file;
        const targetHandle = await this.destinationHandle.getFileHandle(sourceFile.name, { create: true });
        const writable = await (
          targetHandle as unknown as { createWritable: () => Promise<{ write: (data: ArrayBuffer) => Promise<void>; close: () => Promise<void> }> }
        ).createWritable();
        await writable.write(await sourceFile.arrayBuffer());
        await writable.close();
      }
      this.infoMessage = `Copied ${selected.length} selected image${selected.length === 1 ? '' : 's'}.`;
    } catch (error) {
      this.errorMessage = this.readError(error, 'Unable to copy selected images.');
    } finally {
      this.isSelectingDestination = false;
    }
  }

  private openFullscreen(image: AlbumImage): void {
    this.fullscreenImageUrl = image.url;
    this.fullscreenImageName = image.name;
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

  private revokeAllUrls(): void {
    for (const image of this.allImages) {
      URL.revokeObjectURL(image.url);
    }
  }

  private readError(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return fallback;
  }

  private downloadSelectedImages(selected: AlbumImage[]): void {
    for (const image of selected) {
      const link = document.createElement('a');
      link.href = image.url;
      link.download = image.name;
      link.click();
    }
  }

  private getDirectoryPicker(): () => Promise<DirectoryHandle> {
    return (window as unknown as { showDirectoryPicker: () => Promise<DirectoryHandle> }).showDirectoryPicker;
  }

  private clearPendingTap(): void {
    if (this.pendingTapTimer) {
      clearTimeout(this.pendingTapTimer);
      this.pendingTapTimer = null;
    }
    this.pendingTapImageId = null;
  }

  private async loadImagesFromDirectoryHandle(rootHandle: DirectoryHandle): Promise<void> {
    const fileHandles = await this.collectImageHandles(rootHandle);

    this.allImages = await Promise.all(
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
    this.allImages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    this.restoreSelectionFromStorage();
  }

  private async persistSourceFolder(handle: DirectoryHandle): Promise<void> {
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

  private async tryRestoreSourceFolder(): Promise<void> {
    if (!this.supportsDirectoryPicker) {
      return;
    }

    const raw = localStorage.getItem(this.sourceFolderStorageKey);
    if (!raw) {
      return;
    }

    try {
      const db = await this.openSourceHandleDb();
      const handle = await new Promise<DirectoryHandle | null>((resolve, reject) => {
        const tx = db.transaction(this.sourceHandleStoreName, 'readonly');
        const store = tx.objectStore(this.sourceHandleStoreName);
        const request = store.get(this.sourceHandleKey);
        request.onsuccess = () => resolve((request.result as DirectoryHandle | undefined) ?? null);
        request.onerror = () => reject(request.error);
      });
      db.close();

      if (!handle) {
        return;
      }

      this.isLoading = true;
      await this.loadImagesFromDirectoryHandle(handle);
      this.infoMessage = 'Restored images from your previously selected folder.';
    } catch {
      await this.clearSourceFolderStorage();
    } finally {
      this.isLoading = false;
    }
  }

  private async clearSourceFolderStorage(): Promise<void> {
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

  private persistSelectionToStorage(): void {
    const selectedNumbers: number[] = [];
    for (let index = 0; index < this.allImages.length; index += 1) {
      if (this.allImages[index].selected) {
        selectedNumbers.push(index + 1);
      }
    }
    localStorage.setItem(this.selectedNumbersStorageKey, JSON.stringify(selectedNumbers));
  }

  private restoreSelectionFromStorage(): void {
    const raw = localStorage.getItem(this.selectedNumbersStorageKey);
    if (!raw) {
      return;
    }

    try {
      const selectedNumbers = JSON.parse(raw) as number[];
      if (!Array.isArray(selectedNumbers)) {
        return;
      }

      const selectedIndexes = new Set(
        selectedNumbers
          .filter((value) => Number.isInteger(value) && value > 0)
          .map((value) => value - 1),
      );

      for (let index = 0; index < this.allImages.length; index += 1) {
        this.allImages[index].selected = selectedIndexes.has(index);
      }
    } catch {
      localStorage.removeItem(this.selectedNumbersStorageKey);
    }
  }
}
