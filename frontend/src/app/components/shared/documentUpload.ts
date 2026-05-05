const ACCEPTED_UPLOAD_EXTENSIONS = new Set(["pdf", "doc", "docx"]);

export function getSupportedUploadFiles(files: File[]) {
    return files.filter((file) => {
        const extension = file.name.split(".").pop()?.toLowerCase();
        return extension ? ACCEPTED_UPLOAD_EXTENSIONS.has(extension) : false;
    });
}

