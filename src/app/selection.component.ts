import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Router } from '@angular/router';

import { AlbumImage, SourceStoreService } from './source-store.service';

type DirectoryHandle = FileSystemDirectoryHandle;

@Component({
  selector: 'app-selection',
  templateUrl: './selection.component.html',
  styleUrls: ['./selection.component.css'],
})
export class SelectionComponent implements OnInit, OnDestroy {
  @ViewChild('imageFilesInput') private imageFilesInput?: ElementRef<HTMLInputElement>;

  private readonly selectedNamesStoragePrefix = 'album-selector:selected-image-names:';
  private readonly doubleTapMs = 280;
  private readonly copyConcurrency = 4;
  private readonly renderBatchSize = 120;
  private pendingTapTimer: ReturnType<typeof setTimeout> | null = null;
  private infoToastTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTapImageId: string | null = null;
  private destinationHandle: DirectoryHandle | null = null;

  allImages: AlbumImage[] = [];
  isLoading = false;
  errorMessage = '';
  infoMessage = '';
  showInfoToast = false;
  copyProgressText = '';
  copyProgressPercent = 0;
  showFinalizeConfirm = false;
  showSelectedOnly = false;
  visibleCount = this.renderBatchSize;
  fullscreenImageUrl: string | null = null;
  fullscreenImageName = '';
  sourceFolderName = 'no folder selected';

  constructor(private readonly sourceStore: SourceStoreService, private readonly router: Router) {}

  get supportsDirectoryPicker(): boolean {
    return this.sourceStore.supportsDirectoryPicker;
  }

  get selectedCount(): number {
    return this.allImages.filter((image) => image.selected).length;
  }

  get displayedImages(): AlbumImage[] {
    const source = this.showSelectedOnly ? this.allImages.filter((image) => image.selected) : this.allImages;
    return source.slice(0, this.visibleCount);
  }

  get photoCount(): number {
    return this.allImages.length;
  }

  get totalVisibleSourceCount(): number {
    return this.showSelectedOnly ? this.selectedCount : this.photoCount;
  }

  get canLoadMore(): boolean {
    return this.visibleCount < this.totalVisibleSourceCount;
  }

  async ngOnInit(): Promise<void> {
    await this.tryRestoreSourceFolder();
  }

  ngOnDestroy(): void {
    this.clearPendingTap();
    this.clearInfoToastTimer();
    this.sourceStore.revokeImageUrls(this.allImages);
  }

  async pickDirectory(): Promise<void> {
    this.errorMessage = '';
    if (!this.supportsDirectoryPicker) {
      this.imageFilesInput?.nativeElement.click();
      return;
    }

    try {
      this.isLoading = true;
      this.sourceStore.revokeImageUrls(this.allImages);
      const rootHandle = await this.sourceStore.getDirectoryPicker()();
      this.allImages = await this.sourceStore.loadImagesFromDirectoryHandle(rootHandle);
      this.sourceFolderName = rootHandle.name;
      this.restoreSelectionFromStorage();
      this.visibleCount = this.renderBatchSize;
      await this.sourceStore.persistSourceFolder(rootHandle);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Unable to open source folder.';
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

    this.sourceStore.revokeImageUrls(this.allImages);
    this.sourceFolderName = 'manual files';
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
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    this.restoreSelectionFromStorage();
    this.visibleCount = this.renderBatchSize;
    void this.sourceStore.clearPersistedSourceFolder();
    input.value = '';
  }

  onImageTap(image: AlbumImage): void {
    if (this.pendingTapImageId === image.id && this.pendingTapTimer) {
      clearTimeout(this.pendingTapTimer);
      this.pendingTapTimer = null;
      this.pendingTapImageId = null;
      this.fullscreenImageUrl = image.url;
      this.fullscreenImageName = image.name;
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

  async finaliseSelection(): Promise<void> {
    this.errorMessage = '';
    const selected = this.allImages.filter((image) => image.selected);
    if (!selected.length) {
      this.errorMessage = 'Select at least one image before finalising.';
      return;
    }

    if (!this.supportsDirectoryPicker) {
      for (const image of selected) {
        const link = document.createElement('a');
        link.href = image.url;
        link.download = image.name;
        link.click();
      }
      this.pushInfoToast(`Downloaded ${selected.length} selected image${selected.length === 1 ? '' : 's'}.`);
      return;
    }

    try {
      this.isLoading = true;
      if (!this.destinationHandle) {
        this.destinationHandle = await this.sourceStore.getDirectoryPicker()();
      }
      const copyPlan = this.buildCopyPlan(selected);
      this.copyProgressText = `Copying 0/${selected.length}...`;
      this.copyProgressPercent = 0;
      let completed = 0;
      const queue = [...copyPlan];

      const runWorker = async (): Promise<void> => {
        while (queue.length) {
          const task = queue.shift();
          if (!task) {
            return;
          }

          const sourceFile = task.image.handle ? await task.image.handle.getFile() : task.image.file;
          const targetHandle = await this.destinationHandle!.getFileHandle(task.targetName, { create: true });
          const writable = await (
            targetHandle as unknown as { createWritable: () => Promise<{ write: (data: ArrayBuffer) => Promise<void>; close: () => Promise<void> }> }
          ).createWritable();
          await writable.write(await sourceFile.arrayBuffer());
          await writable.close();

          completed += 1;
          await this.updateCopyProgress(completed, selected.length);
        }
      };

      const workerCount = Math.min(this.copyConcurrency, selected.length);
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      await this.updateCopyProgress(selected.length, selected.length);
      await this.sleep(250);
      this.copyProgressText = '';
      this.copyProgressPercent = 0;
      this.pushInfoToast(`Copied ${selected.length} selected image${selected.length === 1 ? '' : 's'}.`);
    } catch (error) {
      this.copyProgressText = '';
      this.copyProgressPercent = 0;
      this.errorMessage = error instanceof Error ? error.message : 'Unable to finalise selection.';
    } finally {
      this.isLoading = false;
    }
  }

  requestFinalize(): void {
    this.errorMessage = '';
    if (!this.selectedCount || this.isLoading) {
      return;
    }
    this.showFinalizeConfirm = true;
  }

  cancelFinalizeConfirm(): void {
    this.showFinalizeConfirm = false;
  }

  async confirmFinalize(): Promise<void> {
    this.showFinalizeConfirm = false;
    await this.finaliseSelection();
  }

  clearSelection(): void {
    for (const image of this.allImages) {
      image.selected = false;
    }
    localStorage.removeItem(this.getSelectionStorageKey());
    this.visibleCount = this.renderBatchSize;
  }

  async goHome(): Promise<void> {
    await this.router.navigate(['/']);
  }

  closeFullscreen(): void {
    this.fullscreenImageUrl = null;
    this.fullscreenImageName = '';
  }

  private async tryRestoreSourceFolder(): Promise<void> {
    try {
      const persisted = await this.sourceStore.getPersistedSourceHandle();
      this.sourceFolderName = persisted.name;
      if (!persisted.handle) {
        return;
      }
      this.isLoading = true;
      this.allImages = await this.sourceStore.loadImagesFromDirectoryHandle(persisted.handle);
      this.restoreSelectionFromStorage();
      this.visibleCount = this.renderBatchSize;
    } finally {
      this.isLoading = false;
    }
  }

  setShowSelectedOnly(enabled: boolean): void {
    this.showSelectedOnly = enabled;
    this.visibleCount = this.renderBatchSize;
  }

  onGalleryScroll(event: Event): void {
    if (!this.canLoadMore) {
      return;
    }
    const element = event.target as HTMLElement;
    const nearBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 220;
    if (nearBottom) {
      this.visibleCount += this.renderBatchSize;
    }
  }

  private clearPendingTap(): void {
    if (this.pendingTapTimer) {
      clearTimeout(this.pendingTapTimer);
      this.pendingTapTimer = null;
    }
    this.pendingTapImageId = null;
  }

  private pushInfoToast(message: string): void {
    this.infoMessage = message;
    this.showInfoToast = true;
    this.clearInfoToastTimer();
    this.infoToastTimer = setTimeout(() => {
      this.showInfoToast = false;
      this.infoToastTimer = null;
    }, 2600);
  }

  private clearInfoToastTimer(): void {
    if (this.infoToastTimer) {
      clearTimeout(this.infoToastTimer);
      this.infoToastTimer = null;
    }
  }

  private persistSelectionToStorage(): void {
    const selectedFileNames = this.allImages
      .filter((image) => image.selected)
      .map((image) => image.name);
    localStorage.setItem(this.getSelectionStorageKey(), JSON.stringify(selectedFileNames));
  }

  private restoreSelectionFromStorage(): void {
    const raw = localStorage.getItem(this.getSelectionStorageKey());
    if (!raw) {
      return;
    }
    try {
      const selectedFileNames = JSON.parse(raw) as string[];
      if (!Array.isArray(selectedFileNames)) {
        return;
      }
      const selectedNames = new Set(
        selectedFileNames.filter((value) => typeof value === 'string' && value.trim().length > 0),
      );
      for (const image of this.allImages) {
        image.selected = selectedNames.has(image.name);
      }
    } catch {
      localStorage.removeItem(this.getSelectionStorageKey());
    }
  }

  private getSelectionStorageKey(): string {
    const source = this.sourceFolderName.trim().toLowerCase() || 'default-source';
    return `${this.selectedNamesStoragePrefix}${source}`;
  }

  private buildCopyPlan(selected: AlbumImage[]): Array<{ image: AlbumImage; targetName: string }> {
    const counts = new Map<string, number>();
    return selected.map((image) => {
      const normalized = image.name.toLowerCase();
      const current = (counts.get(normalized) ?? 0) + 1;
      counts.set(normalized, current);
      if (current === 1) {
        return { image, targetName: image.name };
      }
      return { image, targetName: this.appendCopySuffix(image.name, current) };
    });
  }

  private appendCopySuffix(fileName: string, copyIndex: number): string {
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex <= 0) {
      return `${fileName} (${copyIndex})`;
    }
    const name = fileName.slice(0, dotIndex);
    const ext = fileName.slice(dotIndex);
    return `${name} (${copyIndex})${ext}`;
  }

  private async updateCopyProgress(completed: number, total: number): Promise<void> {
    this.copyProgressText = `Copying ${completed}/${total}...`;
    this.copyProgressPercent = Math.round((completed / total) * 100);
    await this.nextFrame();
  }

  private async nextFrame(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
  }
}
