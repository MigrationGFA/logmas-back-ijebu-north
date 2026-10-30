// form-type-map.ts
/**
 * Form Type Mapping Configuration
 * Maps form type codes to their display names and metadata
 * Used for offline form sync queue classification and reporting
 */

export const formTypeMap: Record<string, { name: string; description: string }> = {
  // Application Forms
  'application_form': {
    name: 'Application Form',
    description: 'General application form',
  },
  'tenement_rate': {
    name: 'Tenement Rate',
    description: 'Tenement rate assessment form',
  },
  'certificate_of_origin': {
    name: 'Certificate of Origin',
    description: 'Certificate of origin request form',
  },
  'birth_certificate': {
    name: 'Birth Certificate',
    description: 'Birth certificate application form',
  },
  'death_certificate': {
    name: 'Death Certificate',
    description: 'Death certificate application form',
  },
  'marriage_certificate': {
    name: 'Marriage Certificate',
    description: 'Marriage certificate application form',
  },

  // Permit/License Forms
  'trade_license': {
    name: 'Trade License',
    description: 'Trade license application form',
  },
  'building_permit': {
    name: 'Building Permit',
    description: 'Building permit application form',
  },
  'shop_license': {
    name: 'Shop License',
    description: 'Shop license application form',
  },

  // Complaint/Violation Forms
  'complaint_form': {
    name: 'Complaint Form',
    description: 'Complaint registration form',
  },
  'violation_report': {
    name: 'Violation Report',
    description: 'Violation reporting form',
  },

  // Notification Forms
  'notification_form': {
    name: 'Notification Form',
    description: 'General notification form',
  },
};

// Export helper functions
export const getFormTypeInfo = (formType: string) => {
  return formTypeMap[formType] || {
    name: formType,
    description: 'Unknown form type',
  };
};

export const isValidFormType = (formType: string): boolean => {
  return formType in formTypeMap;
};

export default formTypeMap;