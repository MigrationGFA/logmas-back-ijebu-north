import { CertificateType, ServiceCategory } from "@prisma/client";
import { prisma } from "../../utils/prisma";

export const listActiveServices = async (category?: string) => {
  return prisma.service.findMany({
    where: {
      isActive: true,
      ...(category ? { category: category as any } : {}),
    },
    include: {
      feeConfig: {
        select: {
          id: true,
          amount: true,
          status: true, layerDepth: true, billingUnit: true, effectiveDate: true, pricingTiers: true,
          updatedAt:true
        },
      },
      _count: {
        select: {
          applications: true,
        },
      },
    },
    orderBy: [
      { category: "asc" },
      { name: "asc" },
    ],
  });
};

export const getActiveServiceByCode = async (code: string) => {
  return prisma.service.findFirst({
    where: {
      isActive: true,
      OR: [
        { id: code },
        {
          code: {
            in:
              code === "certificate_of_origin" || code === "state_of_origin"
                ? ["state_of_origin", "certificate_of_origin"]
                : code === "community_development_levy" || code === "tenement_rate"
                ? ["tenement_rate", "community_development_levy"]
                : code === "marriage_registration" || code === "marriage_certificate"
                ? ["marriage_certificate", "marriage_registration"]
                : code === "environmental_sanitation" || code === "sanitation_compliance"
                ? ["sanitation_compliance", "environmental_sanitation"]
                : [code],
          },
        },
      ],
    },
    include: {
      feeConfig: {
        select: {
          id: true,
          amount: true,
          status: true, layerDepth: true, billingUnit: true, effectiveDate: true, pricingTiers: true,
        },
      },
      _count: {
        select: {
          applications: true,
        },
      },
    },
  });
};

export const createService = async (
  data: {
    code: string;
    name: string;
    category: ServiceCategory;
    revenueHead: string;
    description: string;
    requirements: string[];
    estimatedDays: number;
    certificateType: CertificateType;
    supportsRenewal: boolean;
    isActive: boolean;
    feeConfig: {
      amount: number;
      expiryDate?: Date;
      notes?: string;
    };
  },
  createdById: string,
) => {
  return prisma.$transaction(async (tx) => {
    // --------------------------------------------------
    // 1. VALIDATION
    // --------------------------------------------------

    // Check if service with same code already exists
    const existingService = await tx.service.findUnique({
      where: {
        code: data.code,
      },
      select: {
        id: true,
        code: true,
        name: true,
      },
    });

    if (existingService) {
      throw new Error(`Service with code "${data.code}" already exists`);
    }

    // Validate fee amount
    if (data.feeConfig.amount <= 0) {
      throw new Error("Fee amount must be greater than 0");
    }

    // Check expiry date if provided
    if (data.feeConfig.expiryDate) {
      const expiryDate = new Date(data.feeConfig.expiryDate);
      if (isNaN(expiryDate.getTime())) {
        throw new Error("Invalid expiry date");
      }

    }

    // --------------------------------------------------
    // 2. CREATE SERVICE
    // --------------------------------------------------

    const service = await tx.service.create({
      data: {
        code: data.code,
        name: data.name,
        category: data.category,
        revenueHead: data.revenueHead,
        description: data.description,
        requirements: data.requirements || [],
        estimatedDays: data.estimatedDays || 3,
        certificateType: data.certificateType,
        supportsRenewal: data.supportsRenewal || false,
        isActive: data.isActive !== undefined ? data.isActive : true,
      },
      select: {
        id: true,
        code: true,
        name: true,
        category: true,
        revenueHead: true,
        description: true,
        requirements: true,
        estimatedDays: true,
        certificateType: true,
        supportsRenewal: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // --------------------------------------------------
    // 3. CREATE SERVICE FEE CONFIG
    // --------------------------------------------------

    // Set any existing fee configs to INACTIVE if this is a new active fee
    await tx.serviceFeeConfig.updateMany({
      where: {
        serviceId: service.id,
        status: "ACTIVE",
      },
      data: {
        status: "INACTIVE",
        updatedAt: new Date(),
      },
    });

    const feeConfig = await tx.serviceFeeConfig.create({
      data: {
        serviceId: service.id,
        amount: data.feeConfig.amount,
        expiryDate: data.feeConfig.expiryDate ? new Date(data.feeConfig.expiryDate) : null,
        notes: data.feeConfig.notes || null,
        status: "ACTIVE",
        createdById: createdById,
        updatedById: createdById,
      },
      select: {
        id: true,
        amount: true,
        expiryDate: true,
        notes: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        createdBy: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
        updatedBy: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    // --------------------------------------------------
    // 4. RETURN COMPLETE RESPONSE
    // --------------------------------------------------

    return {
      service,
      feeConfig,
      _meta: {
        createdById,
        createdAt: new Date().toISOString(),
      },
    };
  });
};

export const updateService = async (
  serviceId: string,
  data: {
    code?: string;
    name?: string;
    category?: ServiceCategory;
    revenueHead?: string;
    description?: string;
    requirements?: string[];
    estimatedDays?: number;
    certificateType?: CertificateType;
    supportsRenewal?: boolean;
    isActive?: boolean;
    feeConfig?: {
      amount?: number;
      expiryDate?: Date | null;
      status?: "ACTIVE" | "INACTIVE";
    };
  },
  updatedById: string,
) => {
  return prisma.$transaction(async (tx) => {
    // --------------------------------------------------
    // 1. VALIDATION
    // --------------------------------------------------

    // Check if service exists
    const existingService = await tx.service.findUnique({
      where: {
        id: serviceId,
      },
      include: {
        feeConfig: true,
      },
    });

    if (!existingService) {
      throw new Error(`Service with ID "${serviceId}" not found`);
    }

    // If code is being updated, check for duplicates
    if (data.code && data.code !== existingService.code) {
      const duplicateService = await tx.service.findUnique({
        where: {
          code: data.code,
        },
        select: {
          id: true,
          code: true,
        },
      });

      if (duplicateService) {
        throw new Error(`Service with code "${data.code}" already exists`);
      }
    }

    // Validate fee config if provided
    if (data.feeConfig) {
      if (data.feeConfig.amount !== undefined && data.feeConfig.amount <= 0) {
        throw new Error("Fee amount must be greater than 0");
      }

  
      if (data.feeConfig.expiryDate !== undefined) {
        if (data.feeConfig.expiryDate !== null) {
          const expiryDate = new Date(data.feeConfig.expiryDate);
          if (isNaN(expiryDate.getTime())) {
            throw new Error("Invalid expiry date");
          }
        }
      }
    }

    // --------------------------------------------------
    // 2. UPDATE SERVICE
    // --------------------------------------------------

    const serviceUpdateData: any = {};
    if (data.code !== undefined) serviceUpdateData.code = data.code;
    if (data.name !== undefined) serviceUpdateData.name = data.name;
    if (data.category !== undefined) serviceUpdateData.category = data.category;
    if (data.revenueHead !== undefined) serviceUpdateData.revenueHead = data.revenueHead;
    if (data.description !== undefined) serviceUpdateData.description = data.description;
    if (data.requirements !== undefined) serviceUpdateData.requirements = data.requirements;
    if (data.estimatedDays !== undefined) serviceUpdateData.estimatedDays = data.estimatedDays;
    if (data.certificateType !== undefined) serviceUpdateData.certificateType = data.certificateType;
    if (data.supportsRenewal !== undefined) serviceUpdateData.supportsRenewal = data.supportsRenewal;
    if (data.isActive !== undefined) serviceUpdateData.isActive = data.isActive;

    const service = await tx.service.update({
      where: {
        id: serviceId,
      },
      data: serviceUpdateData,
      select: {
        id: true,
        code: true,
        name: true,
        category: true,
        revenueHead: true,
        description: true,
        requirements: true,
        estimatedDays: true,
        certificateType: true,
        supportsRenewal: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // --------------------------------------------------
    // 3. UPDATE OR CREATE FEE CONFIG
    // --------------------------------------------------

    let feeConfig = null;

    if (data.feeConfig) {
      const existingFeeConfig = existingService.feeConfig;

      // If fee config exists, update it
      if (existingFeeConfig) {
        const feeUpdateData: any = {
          updatedById: updatedById,
          updatedAt: new Date(),
        };

        if (data.feeConfig.amount !== undefined) {
          feeUpdateData.amount = data.feeConfig.amount;
        }
       
        if (data.feeConfig.expiryDate !== undefined) {
          feeUpdateData.expiryDate = data.feeConfig.expiryDate 
            ? new Date(data.feeConfig.expiryDate) 
            : null;
        }
      
        if (data.feeConfig.status !== undefined) {
          feeUpdateData.status = data.feeConfig.status;
        }

        feeConfig = await tx.serviceFeeConfig.update({
          where: {
            id: existingFeeConfig.id,
          },
          data: feeUpdateData,
          select: {
            id: true,
            amount: true,

            status: true, layerDepth: true, billingUnit: true, effectiveDate: true, pricingTiers: true,
            createdAt: true,
            updatedAt: true,
            createdBy: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
              },
            },
            updatedBy: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        });
      } 
      // If no fee config exists, create one
      else {
        if (!data.feeConfig.amount) {
          throw new Error("Amount is required to create a new fee config");
        }

        feeConfig = await tx.serviceFeeConfig.create({
          data: {
            serviceId: serviceId,
            amount: data.feeConfig.amount,
            expiryDate: data.feeConfig.expiryDate ? new Date(data.feeConfig.expiryDate) : null,
            status: data.feeConfig.status || "ACTIVE",
            createdById: updatedById,
            updatedById: updatedById,
          },
          select: {
            id: true,
            amount: true,

            status: true, layerDepth: true, billingUnit: true, effectiveDate: true, pricingTiers: true,
            createdAt: true,
            updatedAt: true,
            createdBy: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
              },
            },
            updatedBy: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        });
      }
    } else {
      // If no fee config data provided, still fetch the existing one
      feeConfig = await tx.serviceFeeConfig.findUnique({
        where: {
          serviceId: serviceId,
        },
        select: {
          id: true,
          amount: true,
          expiryDate: true,
          status: true, layerDepth: true, billingUnit: true, effectiveDate: true, pricingTiers: true,
          createdAt: true,
          updatedAt: true,
          createdBy: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
          updatedBy: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      });
    }

    // --------------------------------------------------
    // 4. RETURN COMPLETE RESPONSE
    // --------------------------------------------------

    return {
      service,
      feeConfig,
      _meta: {
        updatedById,
        updatedAt: new Date().toISOString(),
      },
    };
  });
};