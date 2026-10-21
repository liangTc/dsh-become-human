// Supply the native UI dependency without creating uploads or upload workers.
window.__ModuleLoader__.load({
  id: 'dsh-become-human',
  factory(require) {
    const {Service} = require('@deepseek-ai/cordis');
    class DisabledClientUploads extends Service {
      constructor(ctx) { super(ctx, 'fileUpload'); }
      async post() { throw new Error('P0_UPLOAD_DISABLED'); }
      async upload() { throw new Error('P0_UPLOAD_DISABLED'); }
    }
    return {apply(ctx) { ctx.plugin(DisabledClientUploads); }};
  }
});
