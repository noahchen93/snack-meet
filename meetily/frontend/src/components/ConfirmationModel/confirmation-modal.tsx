import React from 'react';

interface ConfirmationModalProps {
  onConfirm: () => void;
  onCancel: () => void;
  text: string;
  isOpen: boolean;
  /** Optional checkbox shown above the buttons (e.g. "also delete files"). */
  showDeleteFilesOption?: boolean;
  deleteFiles?: boolean;
  onDeleteFilesChange?: (checked: boolean) => void;
}

export function ConfirmationModal({
  onConfirm,
  onCancel,
  text,
  isOpen,
  showDeleteFilesOption,
  deleteFiles,
  onDeleteFilesChange,
}: ConfirmationModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
        <h2 className="text-xl font-semibold mb-4">Confirm Delete</h2>
        <p className="text-gray-600 mb-4">{text}</p>
        {showDeleteFilesOption && (
          <label className="flex items-start gap-2 mb-4 p-3 bg-red-50 rounded-md cursor-pointer">
            <input
              type="checkbox"
              checked={!!deleteFiles}
              onChange={(e) => onDeleteFilesChange?.(e.target.checked)}
              className="mt-0.5 w-4 h-4 text-red-600"
            />
            <span className="text-sm text-red-700">
              同时彻底删除原始录音文件（音频文件和整个会议文件夹，释放磁盘空间）
            </span>
          </label>
        )}
        <div className="flex justify-end space-x-4">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 bg-red-600 text-white hover:bg-red-700 rounded-md transition-colors"
          >
            {deleteFiles ? 'Delete All' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
