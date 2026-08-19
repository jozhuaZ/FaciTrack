function buildStudentUser(session, extraFields = {}) {
    return {
        id: session?.userId,
        name: session?.name,
        firstName: session.firstName,
        lastName: session.lastName,
        status: session.status,
        email: session?.email,
        role: session.role,
        profilePhoto: session?.profilePhoto || 'N/A',
        ...extraFields
    }
}

function buildInstructorUser(session) {
    return {
        id: session?.userId,
        name: session?.name,
        firstName: session.firstName,
        middleName: session.middleName,
        lastName: session.lastName,
        status: session.status,
        email: session?.email,
        position: session.position,
        role: session.role,
        profilePhoto: session?.profilePhoto || null,
        department: session?.department,
    }
}

module.exports = {
    buildStudentUser,
    buildInstructorUser,
};