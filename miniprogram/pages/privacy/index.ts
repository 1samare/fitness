import { releaseMetadata } from '../../services/release-metadata';

interface PageData {
  readonly releaseChannel: string;
  readonly operatorName: string;
  readonly privacyContact: string;
  readonly privacyNoticeVersion: string;
}

interface PageActions {
  onOpenDataRights(): void;
}

Page<PageData, PageActions>({
  data: {
    releaseChannel: releaseMetadata.channel === 'controlled_beta' ? '受控测试' : '本地开发',
    operatorName: releaseMetadata.operatorName,
    privacyContact: releaseMetadata.privacyContact,
    privacyNoticeVersion: releaseMetadata.privacyNoticeVersion
  },

  onOpenDataRights() {
    void wx.navigateTo({ url: '/pages/data-rights/index' });
  }
});
